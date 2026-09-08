use std::path::PathBuf;
use tauri::{Manager, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tokio::sync::{oneshot, Mutex};

#[derive(Default)]
pub struct DirectoryPickers {
    slots: [Mutex<()>; 3],
}

impl DirectoryPickers {
    fn slot(&self, role: &str) -> Result<&Mutex<()>, String> {
        let index = match role {
            "settings" => 0,
            "new-task" => 1,
            "batch-task" => 2,
            _ => {
                return Err(
                    "A download directory can be selected only from settings or a task form".into(),
                )
            }
        };
        Ok(&self.slots[index])
    }
}

fn selected_directory(selected: Option<FilePath>) -> Result<Option<String>, String> {
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|_| "The selected directory is not a filesystem path")?;
    bounded_directory(path).map(Some)
}

fn bounded_directory(path: PathBuf) -> Result<String, String> {
    let text = path
        .to_str()
        .ok_or("The selected directory cannot be represented as UTF-8")?;
    // Match the core's folder bound without touching the directory or turning
    // this user-owned picker into a client-controlled filesystem operation.
    if !path.is_absolute() || text.len() > 4096 || text.contains(['\0', '\r', '\n']) {
        return Err("The selected directory is not a supported absolute path".into());
    }
    Ok(text.to_owned())
}

#[tauri::command]
pub async fn choose_download_directory(
    app: tauri::AppHandle,
    window: WebviewWindow,
    pickers: State<'_, DirectoryPickers>,
) -> Result<Option<String>, String> {
    // Deny before showing anything, including the deterministic hidden-test
    // branch. A burst of requests never queues additional native dialogs.
    let _pending = pickers
        .slot(window.label())?
        .try_lock()
        .map_err(|_| "A directory picker is already open for this window")?;
    if app.state::<crate::windows::Windows>().suppress {
        return Err("Native dialogs are suppressed during hidden acceptance".into());
    }
    let (sender, receiver) = oneshot::channel();
    app.dialog()
        .file()
        .set_title("选择下载目录")
        .set_parent(&window)
        .pick_folder(move |selected| {
            let _ = sender.send(selected);
        });
    // The plugin drives the OS dialog asynchronously. Keep the slot until its
    // callback returns, including Cancel (None), so cancellation cannot allow
    // a second picker while the first one still owns the parent window.
    let selected = receiver
        .await
        .map_err(|_| "The directory picker closed before returning a result")?;
    selected_directory(selected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picker_roles_and_concurrency_are_bounded() {
        let pickers = DirectoryPickers::default();
        for role in ["main", "logs", "about", "", "../settings"] {
            assert!(pickers.slot(role).is_err());
        }
        let slot = pickers.slot("settings").unwrap();
        let pending = slot.try_lock().unwrap();
        assert!(slot.try_lock().is_err());
        assert!(pickers.slot("new-task").unwrap().try_lock().is_ok());
        assert!(pickers.slot("batch-task").unwrap().try_lock().is_ok());
        drop(pending);
        assert!(slot.try_lock().is_ok());
    }

    #[test]
    fn cancellation_returns_no_path_and_selection_must_fit_the_core_contract() {
        assert_eq!(selected_directory(None).unwrap(), None);
        let absolute = std::env::temp_dir().join("下载 with spaces");
        assert_eq!(
            selected_directory(Some(FilePath::Path(absolute.clone()))).unwrap(),
            Some(absolute.to_str().unwrap().to_owned())
        );
        assert!(bounded_directory(PathBuf::from("relative/downloads")).is_err());
        assert!(bounded_directory(std::env::temp_dir().join("x".repeat(4097))).is_err());
        assert!(bounded_directory(std::env::temp_dir().join("bad\nname")).is_err());
        assert!(selected_directory(Some(FilePath::Url(
            tauri::Url::parse("https://example.com/").unwrap()
        )))
        .is_err());
    }
}
