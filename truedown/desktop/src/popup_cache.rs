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
            Kind::Confirmation => ("confirmation", "confirmation.html", 440.0, 160.0),
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
                .min_inner_size(320.0, 144.0)
                .center()
                .icon(
                    tauri::image::Image::from_bytes(include_bytes!("../icons/window/info.png"))
                        .map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?
        } else {
            builder.shadow(true)
        };
        let popup = builder.build().map_err(|e| e.to_string())?;
        if kind == Kind::Confirmation {
            configure_confirmation_frame(&popup)?;
        }
        Ok(popup)
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

// Secondary Windows dialogs have a title and Close button, but no caption icon.
// Keep the warning/error symbol in the content only. Tao retains icon ownership.
#[cfg(target_os = "windows")]
fn configure_confirmation_frame(window: &WebviewWindow) -> Result<(), String> {
    let popup = window.clone();
    window
        .run_on_main_thread(move || unsafe {
            use windows_sys::Win32::UI::WindowsAndMessaging::*;
            if let Ok(handle) = popup.hwnd() {
                let hwnd = handle.0 as _;
                let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_DLGMODALFRAME as isize);
                SendMessageW(hwnd, WM_SETICON, ICON_SMALL as usize, 0);
                SendMessageW(hwnd, WM_SETICON, ICON_BIG as usize, 0);
                SetWindowPos(
                    hwnd,
                    std::ptr::null_mut(),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
                );
            }
        })
        .map_err(|e| e.to_string())
}
#[cfg(not(target_os = "windows"))]
fn configure_confirmation_frame(_: &WebviewWindow) -> Result<(), String> {
    Ok(())
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
