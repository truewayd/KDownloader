use base64::Engine;
use std::{
    io::Read,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager};

const MAX_TORRENT: u64 = 4 * 1024 * 1024;

#[derive(Default)]
pub struct Drops {
    pub pending: Mutex<Option<Source>>,
    pub reading: Arc<tokio::sync::Mutex<()>>,
}

pub enum Source {
    Torrent(PathBuf),
    Links(String),
}

#[derive(serde::Serialize)]
pub struct Torrent {
    name: String,
    base64: String,
    links: String,
}

pub fn links(value: String) -> Torrent {
    Torrent {
        name: String::new(),
        base64: String::new(),
        links: value,
    }
}

pub fn drag_event(window: &tauri::Window, event: &tauri::DragDropEvent) {
    if !["main", "new-task"].contains(&window.label()) {
        return;
    }
    let hover = match event {
        tauri::DragDropEvent::Enter { paths, .. } => {
            (!paths.is_empty()).then(|| single_torrent(paths).is_some())
        }
        tauri::DragDropEvent::Leave | tauri::DragDropEvent::Drop { .. } => None,
        _ => return,
    };
    let _ = window.emit_to(window.label(), "truedown:drop-hover", hover);
    if let tauri::DragDropEvent::Drop { paths, .. } = event {
        receive(window, paths);
    }
}

fn receive(window: &tauri::Window, paths: &[PathBuf]) {
    let Some(path) = single_torrent(paths) else {
        let _ = window.emit(
            "truedown:drop-error",
            "Please drop one .torrent file (up to 4 MiB).",
        );
        return;
    };
    let app = window.app_handle().clone();
    let state = app.state::<Drops>();
    let mut pending = state.pending.lock().unwrap();
    if pending.is_some() {
        let _ = window.emit(
            "truedown:drop-error",
            "Please finish importing the previous dropped file first.",
        );
        return;
    }
    *pending = Some(Source::Torrent(path.clone()));
    drop(pending);
    tauri::async_runtime::spawn(async move {
        if let Err(error) =
            crate::windows::open_auxiliary(app.clone(), crate::windows::Kind::NewTask).await
        {
            let _ = app.emit_to("main", "truedown:drop-error", error);
            return;
        }
        // The form also checks the slot after initialization, so first-window
        // navigation cannot lose a drop that precedes event registration.
        let _ = app.emit_to("new-task", "truedown:drop-ready", ());
    });
}

fn single_torrent(paths: &[PathBuf]) -> Option<&PathBuf> {
    match paths {
        [path] if is_torrent(path) => Some(path),
        _ => None,
    }
}

fn is_torrent(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("torrent"))
}

pub fn read_torrent(path: PathBuf) -> Result<Torrent, String> {
    if !is_torrent(&path) {
        return Err("Only .torrent files can be imported".into());
    }
    let info = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if !info.is_file() || info.len() == 0 || info.len() > MAX_TORRENT {
        return Err("Drop a regular .torrent file between 1 byte and 4 MiB".into());
    }
    let file = std::fs::File::open(&path).map_err(|error| error.to_string())?;
    if !file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("The dropped file is no longer a regular file".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_TORRENT + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_TORRENT {
        return Err("Invalid .torrent file size".into());
    }
    Ok(Torrent {
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        links: String::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hover_and_drop_accept_the_same_single_torrent_name() {
        let path = PathBuf::from("sample.TORRENT");
        assert!(single_torrent(&[]).is_none());
        assert_eq!(single_torrent(std::slice::from_ref(&path)), Some(&path));
        assert!(single_torrent(&[path.clone(), path]).is_none());
        assert!(single_torrent(&[PathBuf::from("sample.torrent.zip")]).is_none());
    }
    #[test]
    fn only_bounded_regular_torrents_are_read() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("sample.TORRENT");
        std::fs::write(&path, b"de").unwrap();
        assert_eq!(read_torrent(path.clone()).unwrap().base64, "ZGU=");
        std::fs::write(&path, []).unwrap();
        assert!(read_torrent(path.clone()).is_err());
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_TORRENT + 1).unwrap();
        assert!(read_torrent(path).is_err());
        assert!(read_torrent(root.path().to_path_buf()).is_err());
        let text = root.path().join("secret.txt");
        std::fs::write(&text, b"private").unwrap();
        assert!(read_torrent(text).is_err());
    }
}
