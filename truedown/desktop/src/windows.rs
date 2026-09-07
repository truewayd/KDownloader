use serde::Deserialize;
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Settings,
    Logs,
    About,
}

pub struct Windows {
    pub suppress: bool,
    pub creation: tokio::sync::Mutex<()>,
    pub cache: std::path::PathBuf,
}

impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Settings => "settings",
            Self::Logs => "logs",
            Self::About => "about",
        }
    }
    fn title(self) -> &'static str {
        match self {
            Self::Settings => "设置 · TrueDown",
            Self::Logs => "应用日志 · TrueDown",
            Self::About => "关于 TrueDown",
        }
    }
    fn url(self) -> &'static str {
        match self {
            Self::Settings => "index.html?window=settings#settings/overview",
            Self::Logs => "index.html?window=logs#logs",
            Self::About => "about.html",
        }
    }
}

pub fn allowed(window: &str, method: &str, path: &str) -> bool {
    match window {
        "main" => true,
        "settings" => {
            !path.starts_with("/tasks")
                && !path.starts_with("/queue/")
                && !path.starts_with("/start-")
                && path != "/system/exit"
        }
        "logs" => method == "GET" && ["/system/logs", "/system/info", "/modules"].contains(&path),
        "about" => method == "GET" && ["/system/info", "/system/update"].contains(&path),
        _ => false,
    }
}

#[tauri::command]
pub async fn open_auxiliary(app: tauri::AppHandle, kind: Kind) -> Result<(), String> {
    let state = app.state::<Windows>();
    let _creation = state.creation.lock().await;
    let window = if let Some(window) = app.get_webview_window(kind.label()) {
        window
    } else {
        let (width, height, min_width, min_height) = match kind {
            Kind::Settings => (1020.0, 760.0, 640.0, 480.0),
            Kind::Logs => (960.0, 680.0, 560.0, 360.0),
            Kind::About => (560.0, 500.0, 420.0, 360.0),
        };
        WebviewWindowBuilder::new(&app, kind.label(), WebviewUrl::App(kind.url().into()))
            .data_directory(state.cache.clone())
            .title(kind.title())
            .inner_size(width, height)
            .min_inner_size(min_width, min_height)
            .visible(false)
            .transparent(cfg!(any(windows, target_os = "macos")))
            .center()
            .on_navigation(local_navigation)
            .build()
            .map_err(|error| error.to_string())?
    };
    if !state.suppress {
        window
            .show()
            .and_then(|_| window.unminimize())
            .and_then(|_| window.set_focus())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn local_navigation(url: &tauri::Url) -> bool {
    matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
    ) && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

#[tauri::command]
pub fn close_auxiliary(window: WebviewWindow) -> Result<(), String> {
    if !["settings", "logs", "about"].contains(&window.label()) {
        return Err("This action closes auxiliary windows only".into());
    }
    // Hiding retains unsaved settings and keyboard position across reopen.
    window.hide().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_have_only_their_own_operations() {
        assert!(!allowed("about", "POST", "/settings/runtime"));
        assert!(!allowed("logs", "GET", "/auth/token"));
        assert!(!allowed("settings", "POST", "/system/exit"));
        assert!(allowed("settings", "POST", "/settings/runtime"));
        assert!(allowed("about", "GET", "/system/info"));
    }
}
