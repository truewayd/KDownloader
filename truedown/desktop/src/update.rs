use std::{io::Write, path::Path, sync::Arc};
use tauri::{Manager, State};

pub struct Health {
    pub directory: std::path::PathBuf,
    pub acknowledged: tokio::sync::Mutex<bool>,
}

#[tauri::command]
pub async fn desktop_ready(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    core: State<'_, Arc<crate::core::Core>>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window can acknowledge native startup".into());
    }
    let path = std::env::var("TRUEDOWN_UPDATE_HEALTH_FILE").unwrap_or_default();
    let token = std::env::var("TRUEDOWN_UPDATE_HEALTH_TOKEN").unwrap_or_default();
    if path.is_empty() && token.is_empty() {
        return Ok(());
    }
    crate::build_info::Info::verify_update()?;
    let health = app.state::<Health>();
    let expected = health.directory.join(format!("native-health-{token}"));
    if !valid_token(&token) || Path::new(&path) != expected {
        return Err("Invalid native startup health location".into());
    }
    let mut acknowledged = health.acknowledged.lock().await;
    if *acknowledged {
        return Ok(());
    }
    let result = acknowledge_health(&window, &core, &health.directory, &expected, &token).await;
    if let Err(error) = &result {
        eprintln!("Native update startup failed: {error}");
        crate::lifecycle::request(&app);
    } else {
        *acknowledged = true;
    }
    result
}

async fn acknowledge_health(
    window: &tauri::WebviewWindow,
    core: &crate::core::Core,
    directory: &Path,
    expected: &Path,
    token: &str,
) -> Result<(), String> {
    if !core.connect().await?.owned {
        return Err("An update must start its own matching core".into());
    }
    // A working core alone must not commit an update with an unusable window.
    crate::appearance::wait_ready(window).await?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(directory).map_err(|error| error.to_string())?;
    temporary
        .write_all(token.as_bytes())
        .map_err(|error| error.to_string())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    temporary
        .persist(expected)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn valid_token(token: &str) -> bool {
    token.len() == 48 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
}

// Run before the CLI or any profile initialization. Both the previous and
// replacement shell can recover an interrupted multi-file replacement.
pub fn before_start(base: &Path, background: bool) -> Result<bool, String> {
    #[cfg(windows)]
    {
        use serde::Deserialize;
        use sha2::{Digest, Sha256};
        use std::{
            fs,
            io::Read,
            os::windows::process::CommandExt,
            process::{Command, Stdio},
        };
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Marker {
            schema_version: u32,
            transaction: String,
            helper: String,
            sha256: String,
            token: String,
        }
        let marker_path = base.join("TrueDown.update.json");
        let info = match fs::symlink_metadata(&marker_path) {
            Ok(info) => info,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.to_string()),
        };
        if !info.is_file() || info.len() > 64 * 1024 {
            return Err("Invalid native update marker".into());
        }
        let bytes = match fs::read(&marker_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.to_string()),
        };
        let marker: Marker =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid native update marker")?;
        if marker.schema_version != 1 || !valid_token(&marker.token) {
            return Err("Invalid native update identity".into());
        }
        if std::env::var("TRUEDOWN_UPDATE_BYPASS").as_deref() == Ok(&marker.token) {
            crate::build_info::Info::verify_update()?;
            return Ok(false);
        }
        // The active updater owns this event through file replacement and
        // health verification. Release our executable mapping immediately.
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::Threading::{OpenEventW, SetEvent, EVENT_MODIFY_STATE},
        };
        let name: Vec<_> = format!("Local\\TrueDown-update-open-{}\0", marker.token)
            .encode_utf16()
            .collect();
        let event = unsafe { OpenEventW(EVENT_MODIFY_STATE, 0, name.as_ptr()) };
        if !event.is_null() {
            let delivered = background || unsafe { SetEvent(event) } != 0;
            unsafe { CloseHandle(event) };
            if !delivered {
                return Err("Cannot signal the active TrueDown update".into());
            }
            // Once committed, a regular launch can activate the new instance.
            return marker_path.try_exists().map_err(|error| error.to_string());
        }
        let helper = Path::new(&marker.helper);
        let parent = helper.parent().ok_or("Invalid native update helper path")?;
        if !helper.is_absolute()
            || helper != parent.join(format!("TrueDown-native-updater-{}.exe", marker.token))
            || Path::new(&marker.transaction)
                != parent.join(format!("native-apply-{}.json", marker.token))
        {
            return Err("Invalid native recovery paths".into());
        }
        let info = fs::symlink_metadata(helper).map_err(|error| error.to_string())?;
        if !info.is_file() || info.len() > 96 * 1024 * 1024 {
            return Err("Invalid native update helper".into());
        }
        let mut file = fs::File::open(helper).map_err(|error| error.to_string())?;
        let mut hash = Sha256::new();
        let mut buffer = [0; 65536];
        let mut size = 0;
        loop {
            let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
            if count == 0 {
                break;
            }
            size += count;
            if size > 96 * 1024 * 1024 {
                return Err("Native helper changed while reading".into());
            }
            hash.update(&buffer[..count]);
        }
        let digest = hash.finalize();
        let actual: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        if actual != marker.sha256 {
            return Err("Native recovery helper failed its SHA-256 check".into());
        }
        Command::new(helper)
            .args([
                "--truedown-apply-native-update",
                &marker.transaction,
                "recover",
            ])
            .env_remove("TRUEDOWN_UPDATE_HEALTH_FILE")
            .env_remove("TRUEDOWN_UPDATE_HEALTH_TOKEN")
            .env_remove("TRUEDOWN_UPDATE_BYPASS")
            .env("TRUEDOWN_UPDATE_OPEN", if background { "0" } else { "1" })
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|error| error.to_string())?;
        Ok(true)
    }
    #[cfg(not(windows))]
    {
        let _ = (base, background);
        Ok(false)
    }
}

#[cfg(all(test, windows))]
mod tests {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_OBJECT_0, WAIT_TIMEOUT},
        System::Threading::{CreateEventW, WaitForSingleObject},
    };

    #[test]
    fn launches_during_an_update_signal_only_explicit_open_requests() {
        let base = tempfile::tempdir().unwrap();
        let token = format!("{:048x}", std::process::id());
        let name: Vec<_> = format!("Local\\TrueDown-update-open-{token}\0")
            .encode_utf16()
            .collect();
        let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, name.as_ptr()) };
        assert!(!event.is_null());
        let marker = serde_json::json!({
            "schemaVersion": 1, "token": token, "transaction": "", "helper": "", "sha256": ""
        });
        std::fs::write(base.path().join("TrueDown.update.json"), marker.to_string()).unwrap();
        assert!(super::before_start(base.path(), true).unwrap());
        assert_eq!(unsafe { WaitForSingleObject(event, 0) }, WAIT_TIMEOUT);
        assert!(super::before_start(base.path(), false).unwrap());
        assert_eq!(unsafe { WaitForSingleObject(event, 0) }, WAIT_OBJECT_0);
        unsafe { CloseHandle(event) };
    }
}
