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
    lock: std::sync::Mutex<()>,
}

impl Startup {
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
            lock: std::sync::Mutex::new(()),
        })
    }

    pub fn state(&self, enabled: Option<bool>) -> Result<State, String> {
        let _lock = self
            .lock
            .lock()
            .map_err(|_| "Startup registration is unavailable")?;
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
    fn platform_state(&self, enabled: Option<bool>) -> Result<State, String> {
        use winreg::{
            enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE},
            RegKey,
        };
        let expected = self
            .args()
            .iter()
            .map(|arg| windows_quote(arg))
            .collect::<Vec<_>>()
            .join(" ");
        if expected.encode_utf16().count() > 260 {
            return Ok(State {
                supported: false,
                enabled: false,
                reason: "程序和数据目录路径超过 Windows 登录启动命令的长度限制。".into(),
            });
        }
        let root = RegKey::predef(HKEY_CURRENT_USER);
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
        let foreign = current.as_ref().is_some_and(|value| value != &expected);
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
        let configured = enabled.unwrap_or(current.as_ref() == Some(&expected));
        let approved = root
            .open_subkey(
                "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run",
            )
            .ok()
            .and_then(|key| key.get_raw_value(&self.name).ok());
        let disabled_by_os = approved.is_some_and(|value| {
            value
                .bytes
                .first()
                .is_some_and(|byte| *byte == 3 || *byte == 7)
        });
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

#[cfg(test)]
mod tests {
    use super::*;
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
}
