//! A bounded, single-use warm window per caller/kind. Never reuse a request identity.
use std::{
    collections::HashMap,
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::{Manager, WebviewWindow};

#[derive(Clone, Copy, PartialEq, Eq, Hash, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Confirmation,
    Menu,
}
#[derive(Default)]
pub struct Cache {
    warm: tokio::sync::Mutex<HashMap<(String, Kind), WebviewWindow>>,
    sequence: AtomicU64,
}
impl Cache {
    fn build(
        &self,
        app: &tauri::AppHandle,
        parent: &WebviewWindow,
        kind: Kind,
    ) -> Result<WebviewWindow, String> {
        let (prefix, page, width, height) = match kind {
            Kind::Confirmation => ("confirmation", "confirmation.html", 480.0, 240.0),
            Kind::Menu => ("context-menu", "context-menu-window.html", 256.0, 80.0),
        };
        let label = format!(
            "{prefix}-{}-{}",
            parent.label(),
            self.sequence.fetch_add(1, Ordering::Relaxed)
        );
        let builder = app
            .state::<crate::windows::Windows>()
            .storage
            .configure(tauri::WebviewWindowBuilder::new(
                app,
                label,
                tauri::WebviewUrl::App(page.into()),
            ))
            .parent(parent)
            .map_err(|e| e.to_string())?
            .title("TrueDown")
            .inner_size(width, height)
            .visible(false)
            .focused(false)
            .skip_taskbar(true)
            .minimizable(false)
            .maximizable(false)
            .decorations(kind == Kind::Confirmation)
            .resizable(kind == Kind::Confirmation)
            .on_navigation(crate::windows::local_navigation);
        let builder = if kind == Kind::Confirmation {
            builder
                .min_inner_size(320.0, 220.0)
                .center()
                .icon(
                    tauri::image::Image::from_bytes(include_bytes!("../icons/window/info.png"))
                        .map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?
        } else {
            builder.shadow(true)
        };
        builder.build().map_err(|e| e.to_string())
    }
    pub async fn take(
        &self,
        app: &tauri::AppHandle,
        parent: &WebviewWindow,
        kind: Kind,
    ) -> Result<WebviewWindow, String> {
        let mut warm = self.warm.lock().await;
        if let Some(window) = warm.remove(&(parent.label().to_string(), kind)) {
            if app.get_webview_window(window.label()).is_some() {
                return Ok(window);
            }
        }
        self.build(app, parent, kind)
    }
}

#[tauri::command]
pub async fn prepare_popup(
    app: tauri::AppHandle,
    window: WebviewWindow,
    kind: Kind,
) -> Result<(), String> {
    crate::editing::authorize(window.label())?;
    if app.state::<crate::windows::Windows>().suppress || !window.is_visible().unwrap_or(false) {
        return Ok(());
    }
    let cache = app.state::<Cache>();
    let mut warm = cache.warm.lock().await;
    let key = (window.label().to_string(), kind);
    if warm.contains_key(&key) {
        return Ok(());
    }
    let popup = cache.build(&app, &window, kind)?;
    let label = popup.label().to_string();
    warm.insert(key.clone(), popup);
    drop(warm);
    // A hover that never becomes an action must not retain a WebView indefinitely.
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        let cache = app.state::<Cache>();
        let mut warm = cache.warm.lock().await;
        if warm.get(&key).is_some_and(|window| window.label() == label) {
            if let Some(window) = warm.remove(&key) {
                let _ = window.destroy();
            }
        }
    });
    Ok(())
}
