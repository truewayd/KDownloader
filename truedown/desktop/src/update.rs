use std::{io::Write, path::Path, sync::Arc};
use tauri::{Manager, State};

pub struct Health {
    directory: std::path::PathBuf,
    checking: tokio::sync::Mutex<()>,
    state: std::sync::Mutex<HealthState>,
}

impl Health {
    pub fn new(directory: std::path::PathBuf) -> Self {
        Self {
            directory,
            checking: Default::default(),
            state: Default::default(),
        }
    }
}

#[derive(Default, PartialEq)]
enum HealthState {
    #[default]
    Starting,
    Ready,
    Expired,
}

// The helper eventually rolls back a replacement that never acknowledges.
// Start graceful shutdown even if the main document never reaches desktop_ready.
pub fn watch_startup(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Allow two normal 15-second surface-readiness windows after core startup.
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        let health = app.state::<Health>();
        let mut state = health.state.lock().unwrap();
        if *state == HealthState::Starting {
            *state = HealthState::Expired;
            drop(state);
            crate::lifecycle::request(&app);
        }
    });
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
    let _checking = health.checking.lock().await;
    match *health.state.lock().unwrap() {
        HealthState::Ready => return Ok(()),
        HealthState::Expired => return Err("Update startup timed out".into()),
        HealthState::Starting => {}
    }
    let result = acknowledge_health(&window, &core, &expected, &token, &health).await;
    if let Err(error) = &result {
        eprintln!("Native update startup failed: {error}");
        crate::lifecycle::request(&app);
    }
    result
}

async fn acknowledge_health(
    window: &tauri::WebviewWindow,
    core: &crate::core::Core,
    expected: &Path,
    token: &str,
    health: &Health,
) -> Result<(), String> {
    if !core.connect().await?.owned {
        return Err("An update must start its own matching core".into());
    }
    // A working core alone must not commit an update with an unusable window.
    crate::appearance::wait_ready(window).await?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(&health.directory).map_err(|error| error.to_string())?;
    temporary
        .write_all(token.as_bytes())
        .map_err(|error| error.to_string())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    let mut state = health.state.lock().unwrap();
    match *state {
        HealthState::Ready => return Ok(()),
        HealthState::Expired => return Err("Update startup timed out".into()),
        HealthState::Starting => {}
    }
    temporary
        .persist(expected)
        .map_err(|error| error.to_string())?;
    *state = HealthState::Ready;
    Ok(())
}

fn valid_token(token: &str) -> bool {
    token.len() == 48 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[derive(Debug, PartialEq)]
pub enum Launch {
    Normal,
    Replacement,
    #[cfg(windows)]
    Forwarded,
}

// Run before the CLI or any profile initialization. Both the previous and
// replacement shell can recover an interrupted multi-file replacement.
pub fn before_start(base: &Path, background: bool) -> Result<Launch, String> {
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
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Launch::Normal)
            }
            Err(error) => return Err(error.to_string()),
        };
        if !info.is_file() || info.len() > 64 * 1024 {
            return Err("Invalid native update marker".into());
        }
        let bytes = match fs::read(&marker_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Launch::Normal)
            }
            Err(error) => return Err(error.to_string()),
        };
        let marker: Marker =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid native update marker")?;
        if marker.schema_version != 1 || !valid_token(&marker.token) {
            return Err("Invalid native update identity".into());
        }
        if std::env::var("TRUEDOWN_UPDATE_BYPASS").as_deref() == Ok(&marker.token) {
            crate::build_info::Info::verify_update()?;
            return Ok(Launch::Replacement);
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
            return Ok(
                if marker_path
                    .try_exists()
                    .map_err(|error| error.to_string())?
                {
                    Launch::Forwarded
                } else {
                    Launch::Normal
                },
            );
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
        Ok(Launch::Forwarded)
    }
    #[cfg(not(windows))]
    {
        let _ = (base, background);
        Ok(Launch::Normal)
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
        assert_eq!(
            super::before_start(base.path(), true).unwrap(),
            super::Launch::Forwarded
        );
        assert_eq!(unsafe { WaitForSingleObject(event, 0) }, WAIT_TIMEOUT);
        assert_eq!(
            super::before_start(base.path(), false).unwrap(),
            super::Launch::Forwarded
        );
        assert_eq!(unsafe { WaitForSingleObject(event, 0) }, WAIT_OBJECT_0);
        unsafe { CloseHandle(event) };
    }
}
