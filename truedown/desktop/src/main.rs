#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod appearance;
mod bridge;
mod build_info;
mod commands;
mod core;
mod frame;
mod menu_icons;
mod pickers;
mod placement;
mod profile;
mod startup;
mod tray_image;
mod update;
mod webview;
mod windows;

use core::Core;
use std::sync::{atomic::Ordering, Arc};
use tauri::{
    menu::{IconMenuItem, Menu},
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tokio::sync::Mutex;

fn show_main(app: &tauri::AppHandle) {
    if app.state::<windows::Windows>().suppress {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        placement::fit(&window.as_ref().window(), false);
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
            "--background" | "background" => background = true,
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
    match update::before_start(&base) {
        Ok(true) => return,
        Ok(false) => {}
        Err(error) => {
            eprintln!("Native update recovery: {error}");
            std::process::exit(1);
        }
    }
    let profile =
        match tauri::async_runtime::block_on(profile::Profile::resolve(&base, data_dir.as_deref()))
        {
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
    let core = Arc::new(Core::new(
        base.join(if cfg!(windows) {
            "truedown-core.exe"
        } else {
            "truedown-core"
        }),
        data_dir.clone(),
    ));
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if !args
                .iter()
                .any(|arg| arg == "--background" || arg == "background")
            {
                show_main(app)
            }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("appearance")
                .js_init_script(appearance::initialization().to_string())
                .build(),
        )
        .manage(core.clone())
        .manage(startup)
        .manage(pickers::DirectoryPickers::default())
        .invoke_handler(tauri::generate_handler![
            commands::core_request,
            commands::desktop_state,
            commands::copy_api_token,
            windows::open_auxiliary,
            windows::close_auxiliary,
            windows::finish_task_window,
            frame::frame_action,
            frame::frame_state,
            frame::frame_title,
            pickers::choose_download_directory,
            appearance::apply_material,
            update::desktop_ready
        ])
        .setup(move |app| {
            if let Err(error) = app.state::<startup::Startup>().migrate_legacy() {
                eprintln!("Cannot migrate login registration: {error}");
            }
            let core = app.state::<Arc<Core>>().inner().clone();
            tauri::async_runtime::block_on(core.connect()).map_err(std::io::Error::other)?;
            let profile = tauri::async_runtime::block_on(profile::Profile::resolve(
                &base,
                data_dir.as_deref(),
            ))
            .map_err(std::io::Error::other)?;
            app.manage(update::Health {
                directory: std::path::PathBuf::from(&profile.paths.state).join("updates"),
            });
            app.manage(windows::Windows {
                suppress: cfg!(debug_assertions)
                    && std::env::var("TRUEDOWN_DESKTOP_TEST").as_deref() == Ok("1"),
                creation: Mutex::new(()),
                storage: webview::Storage::new(&profile),
            });
            for config in &app.config().app.windows {
                let window = frame::configure(
                    app.state::<windows::Windows>()
                        .storage
                        .configure(tauri::WebviewWindowBuilder::from_config(app, config)?),
                )
                .visible(false)
                .on_navigation(windows::local_navigation)
                .build()?;
                frame::install(&window).map_err(std::io::Error::other)?;
                placement::fit(&window.as_ref().window(), true);
                if config.visible && !app.state::<windows::Windows>().suppress {
                    window.show()?;
                }
            }
            let item = |id, text, icon| {
                IconMenuItem::with_id(
                    app,
                    id,
                    text,
                    true,
                    Some(menu_icons::image(icon)?),
                    None::<&str>,
                )
            };
            let open = item("open", "打开 TrueDown", menu_icons::Icon::Download)?;
            let settings = item("settings", "设置…", menu_icons::Icon::Settings)?;
            let logs = item("logs", "应用日志…", menu_icons::Icon::Logs)?;
            let about = item("about", "关于 TrueDown…", menu_icons::Icon::Info)?;
            let exit = item("exit", "退出 TrueDown", menu_icons::Icon::Power)?;
            let menu = Menu::with_items(app, &[&open, &settings, &logs, &about, &exit])?;
            // macOS renders an 18pt status item using its exact Retina raster.
            let icon =
                tray_image::image_for_pixels(if cfg!(target_os = "macos") { 36 } else { 32 })?;
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
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    if core.closing.load(Ordering::SeqCst) {
                        break;
                    }
                    let _ = core.connect().await;
                    if core.exited.load(Ordering::SeqCst) {
                        core.shutdown().await;
                        app_handle.exit(0);
                        break;
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::ScaleFactorChanged { .. } = event {
                placement::fit(window, false);
            }
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
