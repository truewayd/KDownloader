use std::{io::Write, path::Path, sync::Arc};
use tauri::{Manager, State};

pub struct Health {
    pub directory: std::path::PathBuf,
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
    if !core.connect().await?.owned {
        return Err("An update must start its own matching core".into());
    }
    let mut temporary =
        tempfile::NamedTempFile::new_in(&health.directory).map_err(|error| error.to_string())?;
    temporary
        .write_all(token.as_bytes())
        .map_err(|error| error.to_string())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    temporary
        .persist(&expected)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn valid_token(token: &str) -> bool {
    token.len() == 48 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
}

// Run before the CLI or any profile initialization. Both the previous and
// replacement shell can recover an interrupted multi-file replacement.
pub fn before_start(base: &Path) -> Result<bool, String> {
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
        let marker: Marker =
            serde_json::from_slice(&fs::read(marker_path).map_err(|error| error.to_string())?)
                .map_err(|_| "Invalid native update marker")?;
        if marker.schema_version != 1 || !valid_token(&marker.token) {
            return Err("Invalid native update identity".into());
        }
        if std::env::var("TRUEDOWN_UPDATE_BYPASS").as_deref() == Ok(&marker.token) {
            return Ok(false);
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
        if format!("{:x}", hash.finalize()) != marker.sha256 {
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
        let _ = base;
        Ok(false)
    }
}
