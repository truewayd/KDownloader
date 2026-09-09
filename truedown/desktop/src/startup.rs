use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
pub struct State {
    supported: bool,
    enabled: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    reason: String,
}

pub struct Startup {
    name: String,
    executable: PathBuf,
    directory: String,
    unavailable: bool,
    lock: tokio::sync::Mutex<()>,
}

impl Startup {
    // Preserve an already-enabled registration when the native package replaces
    // the legacy executable in place. Only the exact executable/profile pair is
    // eligible; the existing value name and Windows disabled state stay intact.
    pub fn migrate_legacy(&self) -> Result<(), String> {
        #[cfg(windows)]
        {
            use winreg::{
                enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE},
                RegKey,
            };
            let key = match RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(
                "Software\\Microsoft\\Windows\\CurrentVersion\\Run",
                KEY_READ | KEY_WRITE,
            ) {
                Ok(key) => key,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(error.to_string()),
            };
            self.upgrade_legacy_entry(&key)?;
        }
        Ok(())
    }

    pub fn new(identity: &str, directory: String) -> Result<Self, String> {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        // These overrides cannot be reproduced by a login registration. Avoid
        // silently starting another listener or losing externally managed auth.
        let unavailable = [
            "TRUEDOWN_ADDR",
            "TRUEDOWN_TLS_CERT",
            "TRUEDOWN_TLS_KEY",
            "TRUEDOWN_REQUIRE_TOKEN",
            "TRUEDOWN_API_TOKEN",
            "TRUEDOWN_ARIA2_PATH",
        ]
        .iter()
        .any(|key| std::env::var_os(key).is_some_and(|value| !value.is_empty()));
        Ok(Self {
            name: format!("TrueDown-{identity}"),
            executable,
            directory,
            unavailable,
            lock: tokio::sync::Mutex::new(()),
        })
    }

    pub async fn state(&self, enabled: Option<bool>) -> Result<State, String> {
        let _lock = self.lock.lock().await;
        if self.unavailable {
            let reason = "此实例使用环境变量覆盖；请通过对应服务启动器配置开机启动。".to_string();
            if enabled.is_some() {
                return Err(reason);
            }
            return Ok(State {
                supported: false,
                enabled: false,
                reason,
            });
        }
        #[cfg(target_os = "macos")]
        {
            // Removing our registration must remain possible when launchd cannot
            // be queried. Enabling and reading require the authoritative state.
            let disabled = enabled != Some(false) && self.launchd_disabled().await?;
            let mut state = self.platform_state(enabled)?;
            if state.enabled && disabled {
                state.enabled = false;
                state.reason = "已注册，但被 macOS 禁用；请在系统登录项中启用。".into();
            }
            Ok(state)
        }
        #[cfg(not(target_os = "macos"))]
        self.platform_state(enabled)
    }

    fn args(&self) -> Vec<String> {
        vec![
            self.executable.to_string_lossy().into_owned(),
            "--background".into(),
            "--data-dir".into(),
            self.directory.clone(),
        ]
    }
}

#[cfg(windows)]
impl Startup {
    fn expected_command(&self) -> String {
        self.args()
            .iter()
            .map(|arg| windows_quote(arg))
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn is_legacy_command(&self, command: &str) -> bool {
        let Some(args) = windows_arguments(command) else {
            return false;
        };
        args.len() == 4
            && args[0].to_lowercase() == self.executable.to_string_lossy().to_lowercase()
            && args[1] == "background"
            && args[2] == "--data-dir"
            && args[3].to_lowercase() == self.directory.to_lowercase()
    }

    fn upgrade_legacy_entry(&self, key: &winreg::RegKey) -> Result<(), String> {
        let current: String = match key.get_value(&self.name) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.to_string()),
        };
        let expected = self.expected_command();
        if self.is_legacy_command(&current) && expected.encode_utf16().count() <= 260 {
            key.set_value(&self.name, &expected)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn platform_state(&self, enabled: Option<bool>) -> Result<State, String> {
        use winreg::{
            enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE},
            RegKey,
        };
        let expected = self.expected_command();
        if expected.encode_utf16().count() > 260 {
            return Ok(State {
                supported: false,
                enabled: false,
                reason: "程序和数据目录路径超过 Windows 登录启动命令的长度限制。".into(),
            });
        }
        let root = RegKey::predef(HKEY_CURRENT_USER);
        let disabled_by_os = windows_approval_disabled(|| {
            root.open_subkey(
                "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run",
            )
            .and_then(|key| key.get_raw_value(&self.name))
            .map(|value| value.bytes)
        })?;
        let path = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
        let key = match root.open_subkey_with_flags(
            path,
            if enabled.is_some() {
                KEY_READ | KEY_WRITE
            } else {
                KEY_READ
            },
        ) {
            Ok(key) => key,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && enabled != Some(true) => {
                return Ok(State {
                    supported: true,
                    enabled: false,
                    reason: String::new(),
                })
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                root.create_subkey(path)
                    .map_err(|error| error.to_string())?
                    .0
            }
            Err(error) => return Err(error.to_string()),
        };
        let current: Option<String> = match key.get_value(&self.name) {
            Ok(value) => Some(value),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.to_string()),
        };
        let legacy = current
            .as_ref()
            .is_some_and(|value| self.is_legacy_command(value));
        let foreign = current
            .as_ref()
            .is_some_and(|value| value != &expected && !legacy);
        if enabled.is_some() && foreign {
            return Err(
                "此 profile 的登录启动项指向另一份 TrueDown；请先在旧版本中关闭开机启动。".into(),
            );
        }
        if let Some(enabled) = enabled {
            if enabled {
                key.set_value(&self.name, &expected)
                    .map_err(|error| error.to_string())?;
            } else if current.is_some() {
                key.delete_value(&self.name)
                    .map_err(|error| error.to_string())?;
            }
        }
        let configured = enabled.unwrap_or(current.as_ref() == Some(&expected) || legacy);
        let reason = if foreign {
            "此 profile 已有其他 TrueDown 启动项。"
        } else if configured && disabled_by_os {
            "已注册，但被 Windows 任务管理器禁用；请在系统启动应用中启用。"
        } else {
            ""
        };
        Ok(State {
            supported: !foreign,
            enabled: configured && !disabled_by_os,
            reason: reason.into(),
        })
    }
}

#[cfg(any(windows, test))]
fn windows_approval_disabled(
    read: impl FnOnce() -> std::io::Result<Vec<u8>>,
) -> Result<bool, String> {
    match read() {
        Ok(bytes) => Ok(bytes.first().is_some_and(|byte| *byte == 3 || *byte == 7)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Cannot read Windows login approval: {error}")),
    }
}

#[cfg(windows)]
fn windows_arguments(command: &str) -> Option<Vec<String>> {
    use windows_sys::Win32::{Foundation::LocalFree, UI::Shell::CommandLineToArgvW};
    if command.is_empty() || command.contains('\0') || command.len() > 4096 {
        return None;
    }
    let input: Vec<u16> = command.encode_utf16().chain(Some(0)).collect();
    let mut count = 0;
    unsafe {
        let argv = CommandLineToArgvW(input.as_ptr(), &mut count);
        if argv.is_null() {
            return None;
        }
        let result = if count == 4 {
            Some(
                std::slice::from_raw_parts(argv, count as usize)
                    .iter()
                    .map(|argument| {
                        let mut length = 0;
                        while *argument.add(length) != 0 {
                            length += 1;
                        }
                        String::from_utf16_lossy(std::slice::from_raw_parts(*argument, length))
                    })
                    .collect(),
            )
        } else {
            None
        };
        LocalFree(argv.cast());
        result
    }
}

// CommandLineToArgvW-compatible quoting, including trailing backslashes.
#[cfg(any(windows, test))]
fn windows_quote(value: &str) -> String {
    let mut result = String::from("\"");
    let mut slashes = 0;
    for character in value.chars() {
        if character == '\\' {
            slashes += 1;
            continue;
        }
        result.extend(std::iter::repeat_n(
            '\\',
            if character == '"' {
                slashes * 2 + 1
            } else {
                slashes
            },
        ));
        result.push(character);
        slashes = 0;
    }
    result.extend(std::iter::repeat_n('\\', slashes * 2));
    result.push('"');
    result
}

#[cfg(not(windows))]
impl Startup {
    fn platform_state(&self, enabled: Option<bool>) -> Result<State, String> {
        use std::{fs, io::Write};
        let (path, expected) = self.registration()?;
        let current = match fs::symlink_metadata(&path) {
            Ok(info) if info.is_file() && !info.file_type().is_symlink() && info.len() <= 65536 => {
                Some(fs::read(&path).map_err(|error| error.to_string())?)
            }
            Ok(_) => return Err("Startup registration must be a bounded regular file".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.to_string()),
        };
        let foreign = current.as_ref().is_some_and(|value| value != &expected);
        if foreign && enabled.is_some() {
            return Err(
                "此 profile 的启动项属于另一份 TrueDown；请先关闭旧版本的开机启动。".into(),
            );
        }
        match enabled {
            Some(true) => {
                let parent = path.parent().ok_or("Invalid startup directory")?;
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                let mut file =
                    tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
                file.write_all(&expected)
                    .and_then(|_| file.as_file().sync_all())
                    .map_err(|error| error.to_string())?;
                file.persist(&path).map_err(|error| error.to_string())?;
                fs::File::open(parent)
                    .and_then(|file| file.sync_all())
                    .map_err(|error| error.to_string())?;
            }
            Some(false) if current.is_some() => {
                fs::remove_file(&path).map_err(|error| error.to_string())?
            }
            _ => {}
        }
        Ok(State {
            supported: !foreign,
            enabled: enabled.unwrap_or(current.as_ref() == Some(&expected)),
            reason: if foreign {
                "此 profile 已有其他 TrueDown 启动项。".into()
            } else {
                String::new()
            },
        })
    }
}

#[cfg(target_os = "linux")]
impl Startup {
    fn registration(&self) -> Result<(PathBuf, Vec<u8>), String> {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .ok_or("Cannot resolve home directory")?;
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or(home.join(".config"));
        let mut args = self.args();
        if let Some(appimage) = std::env::var_os("APPIMAGE") {
            args[0] = PathBuf::from(appimage).to_string_lossy().into_owned();
        }
        let command = args
            .iter()
            .map(|arg| desktop_quote(arg))
            .collect::<Result<Vec<_>, _>>()?
            .join(" ");
        Ok((config.join("autostart").join(format!("{}.desktop", self.name)), format!("[Desktop Entry]\nType=Application\nVersion=1.0\nName=TrueDown\nExec={command}\nStartupNotify=false\nTerminal=false\n").into_bytes()))
    }
}

#[cfg(any(target_os = "linux", test))]
fn desktop_quote(value: &str) -> Result<String, String> {
    if value.contains(['\n', '\r', '\0']) {
        return Err("Startup paths cannot contain line breaks".into());
    }
    // First escape Exec quoting, then desktop-entry string escaping.
    let mut result = String::from("\"");
    for character in value.chars() {
        if ['"', '`', '$', '\\'].contains(&character) {
            result.push('\\');
        }
        if character == '%' {
            result.push('%');
        }
        result.push(character);
    }
    result.push('"');
    Ok(result.replace('\\', "\\\\"))
}

#[cfg(target_os = "macos")]
impl Startup {
    async fn launchd_disabled(&self) -> Result<bool, String> {
        unsafe extern "C" {
            fn geteuid() -> u32;
        }
        let domain = format!("gui/{}", unsafe { geteuid() });
        let mut command = tokio::process::Command::new("/bin/launchctl");
        command.args(["print-disabled", &domain]);
        let output =
            crate::profile::command_output(&mut command, std::time::Duration::from_secs(15))
                .await
                .map_err(|error| format!("Cannot read macOS login approval: {error}"))?;
        launchd_disabled(&output, &format!("io.truewayd.{}", self.name))
    }

    fn registration(&self) -> Result<(PathBuf, Vec<u8>), String> {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .ok_or("Cannot resolve home directory")?;
        let mut value = plist::Dictionary::new();
        value.insert("Label".into(), format!("io.truewayd.{}", self.name).into());
        value.insert(
            "ProgramArguments".into(),
            plist::Value::Array(self.args().into_iter().map(plist::Value::String).collect()),
        );
        value.insert("RunAtLoad".into(), true.into());
        let mut bytes = Vec::new();
        plist::Value::Dictionary(value)
            .to_writer_xml(&mut bytes)
            .map_err(|error| error.to_string())?;
        Ok((
            home.join("Library/LaunchAgents")
                .join(format!("io.truewayd.{}.plist", self.name)),
            bytes,
        ))
    }
}

#[cfg(any(target_os = "macos", test))]
fn launchd_disabled(output: &[u8], label: &str) -> Result<bool, String> {
    let invalid = "Invalid macOS login approval response";
    let text = std::str::from_utf8(output).map_err(|_| invalid)?;
    let mut lines = text.lines().map(str::trim).filter(|line| !line.is_empty());
    if lines.next() != Some("disabled services = {") {
        return Err(invalid.into());
    }
    let mut disabled = None;
    let mut section = "disabled services";
    while let Some(line) = lines.next() {
        if line == "}" {
            match lines.next() {
                None => return Ok(disabled.unwrap_or(false)),
                Some("login item associations = {") if section == "disabled services" => {
                    section = "login item associations";
                    continue;
                }
                _ => return Err(invalid.into()),
            }
        }
        let (name, value) = line.split_once("=>").ok_or(invalid)?;
        let name: String = serde_json::from_str(name.trim()).map_err(|_| invalid)?;
        if section == "login item associations" {
            serde_json::from_str::<String>(value.trim()).map_err(|_| invalid)?;
            continue;
        }
        let value = match value.trim() {
            "true" | "disabled" => true,
            "false" | "enabled" => false,
            _ => return Err(invalid.into()),
        };
        if name == label && disabled.replace(value).is_some() {
            return Err(invalid.into());
        }
    }
    Err(invalid.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_approval_read_failures_do_not_report_enabled() {
        use std::io::{Error, ErrorKind};
        let failed = windows_approval_disabled(|| Err(Error::from(ErrorKind::PermissionDenied)));
        assert!(failed
            .unwrap_err()
            .starts_with("Cannot read Windows login approval:"));
        assert!(!windows_approval_disabled(|| Err(Error::from(ErrorKind::NotFound))).unwrap());
        for state in [2, 3, 6, 7] {
            let mut bytes = vec![0; 12];
            bytes[0] = state;
            assert_eq!(
                windows_approval_disabled(|| Ok(bytes)).unwrap(),
                state == 3 || state == 7
            );
        }
    }

    #[test]
    fn launchd_approval_requires_an_exact_unambiguous_label() {
        let label = "io.truewayd.TrueDown-fixture";
        for (entries, expected) in [
            (format!("\"{label}\" => true"), true),
            (format!("\"{label}\" => false"), false),
            (format!("\"{label}\" => disabled"), true),
            (format!("\"{label}\" => enabled"), false),
            (format!("\"{label}-other\" => true"), false),
            (String::new(), false),
        ] {
            let output = format!("disabled services = {{\n{entries}\n}}\n");
            assert_eq!(
                launchd_disabled(output.as_bytes(), label).unwrap(),
                expected
            );
            let with_associations = format!(
                "{output}login item associations = {{\n\"{label}\" => \"another.app\"\n}}\n"
            );
            assert_eq!(
                launchd_disabled(with_associations.as_bytes(), label).unwrap(),
                expected
            );
        }
        for output in [
            format!("disabled services = {{\n\"{label}\" => true\n\"{label}\" => false\n}}"),
            format!("disabled services = {{\n\"{label}\" => unknown\n}}"),
            format!("disabled services = {{\n\"{label}\" => true"),
            "disabled services = {\n}\nunexpected".into(),
            "disabled services = {\n}\nlogin item associations = {\n\"app\" => false\n}".into(),
            "disabled services = {\n}\nlogin item associations = {".into(),
            "unrecognized output".into(),
        ] {
            assert!(launchd_disabled(output.as_bytes(), label).is_err());
        }
        assert!(launchd_disabled(&[0xff], label).is_err());
    }

    #[test]
    fn login_arguments_preserve_spaces_quotes_and_backslashes() {
        assert_eq!(
            windows_quote("C:\\My Downloads\\"),
            "\"C:\\My Downloads\\\\\""
        );
        assert_eq!(windows_quote("a\"b"), "\"a\\\"b\"");
        assert_eq!(
            desktop_quote("/home/a b/100%").unwrap(),
            "\"/home/a b/100%%\""
        );
        assert!(desktop_quote("/home/a\nb").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn migration_changes_only_an_in_place_legacy_registration() {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        let root = RegKey::predef(HKEY_CURRENT_USER);
        let path = format!("Software\\TrueDownTests\\startup-{}", std::process::id());
        let key = root.create_subkey(&path).unwrap().0;
        let startup = Startup {
            name: "TrueDown-fixture".into(),
            executable: PathBuf::from("C:\\Test Application\\TrueDown.exe"),
            directory: "C:\\Test Profile".into(),
            unavailable: false,
            lock: tokio::sync::Mutex::new(()),
        };
        let legacy =
            "\"C:\\Test Application\\TrueDown.exe\" background --data-dir \"C:\\Test Profile\"";
        assert!(startup.is_legacy_command(legacy));
        key.set_value(&startup.name, &legacy).unwrap();
        startup.upgrade_legacy_entry(&key).unwrap();
        assert_eq!(
            key.get_value::<String, _>(&startup.name).unwrap(),
            startup.expected_command()
        );
        for foreign in [
            legacy.replace("Test Application", "Other Application"),
            legacy.replace("Test Profile", "Other Profile"),
            format!("{legacy} --extra"),
        ] {
            key.set_value(&startup.name, &foreign).unwrap();
            startup.upgrade_legacy_entry(&key).unwrap();
            assert_eq!(key.get_value::<String, _>(&startup.name).unwrap(), foreign);
        }
        drop(key);
        root.delete_subkey_all(&path).unwrap();
    }
}
