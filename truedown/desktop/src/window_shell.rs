//! Recreate only the native shell; the live WebView retains its document.
use tauri::{Manager, WebviewWindow, WindowBuilder};

#[derive(Default)]
pub struct Shells(std::sync::Mutex<std::collections::HashMap<String, Retained>>);

#[derive(Clone)]
struct Retained {
    retiring: Option<tauri::Window>,
    webview: tauri::Webview,
    title: String,
    position: tauri::PhysicalPosition<i32>,
    size: tauri::PhysicalSize<u32>,
    scale: f64,
    icon: tauri::image::Image<'static>,
}

// Creation is serialized by Windows::creation. If native allocation or frame
// setup fails, retain the document and retry attachment on the next open.
pub async fn recover(app: &tauri::AppHandle, label: &str) -> Result<Option<WebviewWindow>, String> {
    let retained = app
        .state::<Shells>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(label)
        .cloned();
    match retained {
        Some(retained) => complete(app, label, retained).await.map(Some),
        None => Ok(None),
    }
}

pub async fn renew(
    window: WebviewWindow,
    icon: tauri::image::Image<'static>,
) -> Result<WebviewWindow, String> {
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    let title = window.title().map_err(|e| e.to_string())?;
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let parking = if let Some(parking) = app.get_window("native-shell-parking") {
        parking
    } else {
        WindowBuilder::new(&app, "native-shell-parking")
            .visible(false)
            .skip_taskbar(true)
            .focused(false)
            .build()
            .map_err(|e| e.to_string())?
    };
    let webview: &tauri::Webview = window.as_ref();
    let webview = webview.clone();
    let retiring = webview.window();
    webview.reparent(&parking).map_err(|e| e.to_string())?;
    let retained = Retained {
        retiring: Some(retiring),
        webview,
        title,
        position,
        size,
        scale,
        icon,
    };
    app.state::<Shells>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(label.clone(), retained.clone());
    complete(&app, &label, retained).await
}

async fn complete(
    app: &tauri::AppHandle,
    label: &str,
    mut retained: Retained,
) -> Result<WebviewWindow, String> {
    if let Some(old) = retained.retiring.as_ref() {
        if app.get_window(label).is_some() {
            old.destroy().map_err(|e| e.to_string())?;
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while app.get_window(label).is_some() {
            if std::time::Instant::now() >= deadline {
                return Err("Native shell retirement timed out; the document is retained".into());
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        retained.retiring = None;
        app.state::<Shells>()
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .insert(label.to_owned(), retained.clone());
    }
    let Retained {
        webview,
        title,
        position,
        size,
        scale,
        icon,
        ..
    } = retained;
    let native = if let Some(native) = app.get_window(label) {
        native
    } else {
        WindowBuilder::new(app, label)
            .title(title)
            .icon(icon)
            .map_err(|e| e.to_string())?
            .inner_size(size.width as f64 / scale, size.height as f64 / scale)
            .visible(false)
            .resizable(label == "task-preview")
            .maximizable(label == "task-preview")
            .transparent(true)
            .build()
            .map_err(|e| e.to_string())?
    };
    native.set_position(position).map_err(|e| e.to_string())?;
    webview.reparent(&native).map_err(|e| e.to_string())?;
    let window = app
        .get_webview_window(label)
        .ok_or("Native shell attachment failed")?;
    crate::frame::install_async(&window).await?;
    let offset = crate::frame::sizing_offset(&native)?;
    native
        .set_size(tauri::LogicalSize::new(
            (size.width as f64 / scale - offset.0).max(1.0),
            (size.height as f64 / scale - offset.1).max(1.0),
        ))
        .map_err(|e| e.to_string())?;
    crate::appearance::restore(&window).await?;
    app.state::<Shells>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .remove(label);
    Ok(window)
}
