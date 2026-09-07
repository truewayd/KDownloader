#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod appearance;
mod bridge;
mod profile;
mod startup;
mod tray_image;
mod windows;

use bridge::{Bridge, Request, Response};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager, State, WindowEvent,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tokio::sync::Mutex;

struct Core {
    bridge: Mutex<Option<Arc<Bridge>>>,
    executable: PathBuf,
    data_dir: Option<String>,
    closing: AtomicBool,
    failure: Mutex<Option<String>>,
}
impl Core {
    async fn connect(&self) -> Result<Arc<Bridge>, String> {
        if self.closing.load(Ordering::SeqCst) {
            return Err("TrueDown is shutting down".into());
        }
        let mut slot = self.bridge.lock().await;
        if let Some(error) = self.failure.lock().await.as_ref() {
            return Err(error.clone());
        }
        if let Some(bridge) = slot.as_ref() {
            if bridge.alive.load(Ordering::SeqCst) {
                return Ok(bridge.clone());
            }
            return Err("Core disconnected; reopen TrueDown to recover".into());
        }
        let bridge = match Bridge::spawn(self.executable.clone(), self.data_dir.as_deref()).await {
            Ok(bridge) => bridge,
            Err(error) => {
                *self.failure.lock().await = Some(error.clone());
                return Err(error);
            }
        };
        *slot = Some(bridge.clone());
        Ok(bridge)
    }
    async fn shutdown(&self) {
        if self.closing.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(bridge) = self.bridge.lock().await.take() {
            bridge.shutdown().await
        }
    }
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopState {
    owned: bool,
    protocol_version: u32,
}

#[tauri::command]
async fn desktop_state(core: State<'_, Arc<Core>>) -> Result<DesktopState, String> {
    let bridge = core.connect().await?;
    Ok(DesktopState {
        owned: bridge.owned,
        protocol_version: 1,
    })
}

#[tauri::command]
async fn core_request(
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
    let bridge = core.connect().await?;
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
        let state = app.state::<startup::Startup>().state(enabled)?;
        return Ok(Response {
            id: 0,
            event: String::new(),
            protocol_version: 1,
            owned: bridge.owned,
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
            owned: bridge.owned,
            status: 202,
            body: "{\"accepted\":true}".into(),
            headers: Default::default(),
            error: String::new(),
        });
    }
    let hide_token = path == "/auth/settings";
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
async fn copy_api_token(
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

fn show_main(app: &tauri::AppHandle) {
    if app.state::<windows::Windows>().suppress {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut data_dir = None;
    let mut background = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--background" => background = true,
            "--data-dir" => {
                index += 1;
                data_dir = args.get(index).cloned();
                if data_dir.is_none() {
                    eprintln!("--data-dir requires a directory");
                    return;
                }
            }
            _ => {
                eprintln!("Unsupported desktop argument");
                return;
            }
        }
        index += 1;
    }
    let base = std::env::current_exe()
        .expect("desktop executable")
        .parent()
        .unwrap()
        .to_path_buf();
    let profile = match profile::Profile::resolve(&base, data_dir.as_deref()) {
        Ok(profile) => profile,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };
    let identity = profile.identity();
    let startup =
        startup::Startup::new(&identity, profile.data_directory).expect("resolve login startup");
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!("io.truewayd.truedown.p{identity}");
    context.config_mut().app.macos_private_api = cfg!(target_os = "macos");
    for window in &mut context.config_mut().app.windows {
        window.transparent = cfg!(any(windows, target_os = "macos"));
        // Build explicitly after the core commits any profile migration. Tauri's
        // config path accepts relative paths only; the builder accepts the
        // authoritative absolute cache path returned by the Go profile owner.
        window.create = false;
    }
    // Start hidden at creation time, so background launches never flash a window.
    if background {
        for window in &mut context.config_mut().app.windows {
            window.visible = false;
        }
    }
    let core = Arc::new(Core {
        bridge: Mutex::new(None),
        executable: base.join(if cfg!(windows) {
            "truedown-core.exe"
        } else {
            "truedown-core"
        }),
        data_dir: data_dir.clone(),
        closing: AtomicBool::new(false),
        failure: Mutex::new(None),
    });
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if !args.iter().any(|arg| arg == "--background") {
                show_main(app)
            }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("appearance")
                .js_init_script(appearance::initialization().to_string())
                .build(),
        )
        .manage(core.clone())
        .manage(startup)
        .invoke_handler(tauri::generate_handler![
            core_request,
            desktop_state,
            copy_api_token,
            windows::open_auxiliary,
            windows::close_auxiliary,
            appearance::apply_material
        ])
        .setup(move |app| {
            let core = app.state::<Arc<Core>>().inner().clone();
            tauri::async_runtime::block_on(core.connect()).map_err(std::io::Error::other)?;
            let profile = profile::Profile::resolve(&base, data_dir.as_deref())
                .map_err(std::io::Error::other)?;
            let cache = PathBuf::from(profile.paths.cache).join("webview");
            app.manage(windows::Windows {
                suppress: cfg!(debug_assertions)
                    && std::env::var("TRUEDOWN_DESKTOP_TEST").as_deref() == Ok("1"),
                creation: Mutex::new(()),
                cache: cache.clone(),
            });
            for config in &app.config().app.windows {
                tauri::WebviewWindowBuilder::from_config(app, config)?
                    .data_directory(cache.clone())
                    .on_navigation(windows::local_navigation)
                    .build()?;
            }
            let open = MenuItem::with_id(app, "open", "打开 TrueDown", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
            let logs = MenuItem::with_id(app, "logs", "应用日志…", true, None::<&str>)?;
            let about = MenuItem::with_id(app, "about", "关于 TrueDown…", true, None::<&str>)?;
            let exit = MenuItem::with_id(app, "exit", "退出 TrueDown", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &settings, &logs, &about, &exit])?;
            let icon = tray_image::image_for_pixels(32)?;
            let tray = TrayIconBuilder::new()
                .icon(icon)
                .tooltip("TrueDown")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "settings" | "logs" | "about" => {
                        let kind = match event.id.as_ref() {
                            "settings" => windows::Kind::Settings,
                            "logs" => windows::Kind::Logs,
                            _ => windows::Kind::About,
                        };
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = windows::open_auxiliary(app, kind).await;
                        });
                    }
                    "exit" => {
                        let app = app.clone();
                        let core = app.state::<Arc<Core>>().inner().clone();
                        tauri::async_runtime::spawn(async move {
                            core.shutdown().await;
                            app.exit(0)
                        });
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(event, TrayIconEvent::DoubleClick { .. }) {
                        show_main(tray.app_handle())
                    }
                })
                .build(app)?;
            tray_image::track(tray);
            if background {
                if let Some(window) = app.get_webview_window("main") {
                    window.hide()?
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(context)
        .expect("initialize TrueDown desktop");
    application.run(move |app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if !core.closing.load(Ordering::SeqCst) {
                api.prevent_exit();
                let core = core.clone();
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    core.shutdown().await;
                    app.exit(0)
                });
            }
        }
    });
}
