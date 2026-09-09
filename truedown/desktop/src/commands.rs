//! Native IPC authorization and credential handling, separate from shell startup.
use crate::{
    bridge::{Request, Response},
    core::Core,
    startup, windows,
};
use std::sync::{atomic::Ordering, Arc};
use tauri::{Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopState {
    owned: bool,
    protocol_version: u32,
}

#[tauri::command]
pub async fn desktop_state(core: State<'_, Arc<Core>>) -> Result<DesktopState, String> {
    let bridge = core.connect().await?;
    Ok(DesktopState {
        owned: bridge.owned,
        protocol_version: 1,
    })
}

#[tauri::command]
pub async fn core_request(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    core: State<'_, Arc<Core>>,
    request: Request,
) -> Result<Response, String> {
    request.validate()?;
    let path = request.path.split('?').next().unwrap_or("");
    if !windows::allowed(window.label(), &request.method, path) {
        return Err("This operation is unavailable in this window".into());
    }
    if path == "/auth/token" {
        return Err("Use the native clipboard action for API credentials".into());
    }
    if path == "/settings/startup" {
        let enabled = if request.method == "POST" {
            #[derive(serde::Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Startup {
                enabled: bool,
            }
            let value: Startup =
                serde_json::from_str(&request.body).map_err(|_| "Invalid startup setting")?;
            Some(value.enabled)
        } else {
            None
        };
        let state = app.state::<startup::Startup>().state(enabled).await?;
        return Ok(Response {
            id: 0,
            event: String::new(),
            protocol_version: 1,
            owned: core.owned.load(Ordering::SeqCst),
            status: 200,
            body: serde_json::to_string(&state).map_err(|error| error.to_string())?,
            headers: Default::default(),
            error: String::new(),
        });
    }
    if path == "/system/exit" {
        let state = core.inner().clone();
        tauri::async_runtime::spawn(async move {
            state.shutdown().await;
            app.exit(0)
        });
        return Ok(Response {
            id: 0,
            event: String::new(),
            protocol_version: 1,
            owned: core.owned.load(Ordering::SeqCst),
            status: 202,
            body: "{\"accepted\":true}".into(),
            headers: Default::default(),
            error: String::new(),
        });
    }
    let hide_token = path == "/auth/settings";
    let bridge = core.connect().await?;
    let mut response = bridge.request(request).await?;
    if hide_token && response.status == 200 {
        let mut value: serde_json::Value =
            serde_json::from_str(&response.body).map_err(|_| "Invalid auth response")?;
        if let Some(object) = value.as_object_mut() {
            object.remove("token");
        }
        response.body = value.to_string();
    }
    Ok(response)
}

#[tauri::command]
pub async fn copy_api_token(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    core: State<'_, Arc<Core>>,
) -> Result<bool, String> {
    if window.label() != "settings" {
        return Err("API credentials are available from settings only".into());
    }
    let response = core
        .connect()
        .await?
        .request(Request::new("GET", "/auth/token"))
        .await?;
    if response.status != 200 {
        return Err("Cannot read the API credential".into());
    }
    let value: serde_json::Value =
        serde_json::from_str(&response.body).map_err(|_| "Invalid credential response")?;
    if value["enabled"] != true {
        return Ok(false);
    }
    let token = value["token"]
        .as_str()
        .ok_or("API credential unavailable")?;
    app.clipboard()
        .write_text(token)
        .map_err(|error| error.to_string())?;
    Ok(true)
}
