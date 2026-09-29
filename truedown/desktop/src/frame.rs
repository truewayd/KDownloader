//! Native caption buttons and bounded operations on the calling window.
use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewWindow, WebviewWindowBuilder, Wry};

#[cfg(windows)]
mod windows;

pub fn navigation_started(webview: &tauri::Webview) {
    #[cfg(windows)]
    {
        let window = webview.window();
        let owned = window.clone();
        let _ = window.run_on_main_thread(move || {
            if let Ok(handle) = owned.hwnd() {
                unsafe {
                    let _ = windows::tooltip(handle.0, 0, 0, None);
                }
            }
        });
    }
    #[cfg(not(windows))]
    let _ = webview;
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TooltipBounds {
    left: f64,
    top: f64,
    width: f64,
    height: f64,
    radius: f64,
    viewport_width: f64,
    viewport_height: f64,
}

impl TooltipBounds {
    fn valid(&self) -> bool {
        [
            self.left,
            self.top,
            self.width,
            self.height,
            self.radius,
            self.viewport_width,
            self.viewport_height,
        ]
        .iter()
        .all(|v| v.is_finite())
            && self.left >= 0.0
            && self.top >= 0.0
            && self.width > 0.0
            && self.width <= 321.0
            && self.height > 0.0
            && self.height <= 4096.0
            && self.radius >= 0.0
            && self.radius <= 16.0
            && self.viewport_width > 0.0
            && self.viewport_width <= 32768.0
            && self.viewport_height > 0.0
            && self.viewport_height <= 32768.0
            && self.left + self.width <= self.viewport_width + 1.0
            && self.top + self.height <= self.viewport_height + 1.0
    }
}

/// Only the caller's shared tooltip may reveal pixels over its caption.
#[tauri::command]
pub async fn frame_tooltip(
    window: WebviewWindow,
    session: u32,
    revision: u32,
    bounds: Option<TooltipBounds>,
) -> Result<u32, String> {
    if !matches!(
        window.label(),
        "main" | "settings" | "new-task" | "task-details"
    ) || bounds.as_ref().is_some_and(|bounds| !bounds.valid())
        || (session == 0 && (revision != 0 || bounds.is_some()))
    {
        return Err("Invalid tooltip layout".into());
    }
    #[cfg(windows)]
    {
        let owned = window.clone();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        window
            .run_on_main_thread(move || {
                let result = owned
                    .hwnd()
                    .map_err(|e| e.to_string())
                    .and_then(|handle| unsafe {
                        windows::tooltip(handle.0, session, revision, bounds)
                    });
                let _ = sender.send(result);
            })
            .map_err(|e| e.to_string())?;
        receiver.await.map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    Err("Native tooltip clipping is Windows-only".into())
}

/// Setup already runs on the UI thread; auxiliary creation dispatches here.
pub fn install(window: &WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    unsafe {
        windows::install(window.hwnd().map_err(|error| error.to_string())?.0)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Ok(())
    }
}

pub async fn install_async(window: &WebviewWindow) -> Result<(), String> {
    let owned = window.clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread(move || {
            let _ = sender.send(install(&owned));
        })
        .map_err(|error| error.to_string())?;
    receiver.await.map_err(|error| error.to_string())?
}

// Tao converts client sizes using the standard frame, even after our
// WM_NCCALCSIZE handler extends the client into the title bar.
pub fn sizing_offset(window: &tauri::Window) -> Result<(f64, f64), String> {
    #[cfg(windows)]
    unsafe {
        windows::sizing_offset(window.hwnd().map_err(|error| error.to_string())?.0)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Ok((0.0, 0.0))
    }
}

pub fn configure<'a, M: Manager<Wry>>(
    builder: WebviewWindowBuilder<'a, Wry, M>,
) -> WebviewWindowBuilder<'a, Wry, M> {
    #[cfg(target_os = "macos")]
    {
        builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(14.0, 16.0))
    }
    #[cfg(not(target_os = "macos"))]
    builder.decorations(true).shadow(true)
}

#[tauri::command]
pub fn frame_title(window: WebviewWindow, title: String) -> Result<(), String> {
    if title.chars().count() > 160 || title.chars().any(char::is_control) {
        return Err("Invalid window title".into());
    }
    window.set_title(&title).map_err(|error| error.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Action {
    Minimize,
    Maximize,
    Close,
    Drag,
    SystemMenu,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    maximized: bool,
    decorated: bool,
}

#[tauri::command]
pub fn frame_state(window: WebviewWindow) -> Result<State, String> {
    Ok(State {
        maximized: window.is_maximized().map_err(|error| error.to_string())?,
        decorated: window.is_decorated().map_err(|error| error.to_string())?,
    })
}

#[tauri::command]
pub fn frame_action(window: WebviewWindow, action: Action) -> Result<(), String> {
    match action {
        Action::Minimize => window.minimize(),
        Action::Maximize => {
            if !window.is_maximizable().map_err(|error| error.to_string())? {
                return Ok(());
            }
            if window.is_maximized().map_err(|error| error.to_string())? {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        // Closing the frame is the same hide-to-tray action as Alt+F4. It must
        // never stop the core or destroy an auxiliary window's unsaved draft.
        Action::Close => {
            window.hide().map_err(|error| error.to_string())?;
            crate::windows::task_details_hidden(window.app_handle(), window.label());
            return Ok(());
        }
        Action::Drag => window.start_dragging(),
        Action::SystemMenu => return system_menu(&window),
    }
    .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn system_menu(window: &WebviewWindow) -> Result<(), String> {
    use windows_sys::Win32::{Foundation::POINT, UI::WindowsAndMessaging::*};
    let mut point = POINT::default();
    if unsafe { GetCursorPos(&mut point) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let owned = window.clone();
    window
        .run_on_main_thread(move || unsafe {
            let Ok(handle) = owned.hwnd() else {
                return;
            };
            let hwnd = handle.0;
            if IsWindowVisible(hwnd) == 0 || GetForegroundWindow() != hwnd {
                return;
            }
            // Our title strip is client area: a forwarded WM_CONTEXTMENU may fail
            // the OS caption hit test. Track the genuine borrowed system menu here.
            let menu = GetSystemMenu(hwnd, 0);
            if menu.is_null() {
                return;
            }
            let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
            let maximized = IsZoomed(hwnd) != 0;
            let minimized = IsIconic(hwnd) != 0;
            for (command, enabled) in [
                (SC_RESTORE, maximized || minimized),
                (SC_MOVE, !maximized && !minimized),
                (
                    SC_SIZE,
                    !maximized && !minimized && style & WS_THICKFRAME != 0,
                ),
                (SC_MINIMIZE, !minimized && style & WS_MINIMIZEBOX != 0),
                (SC_MAXIMIZE, !maximized && style & WS_MAXIMIZEBOX != 0),
            ] {
                EnableMenuItem(
                    menu,
                    command,
                    MF_BYCOMMAND | if enabled { MF_ENABLED } else { MF_GRAYED },
                );
            }
            let selected = TrackPopupMenuEx(
                menu,
                TPM_LEFTALIGN | TPM_WORKAREA | TPM_NOANIMATION | TPM_RETURNCMD | TPM_RIGHTBUTTON,
                point.x,
                point.y,
                hwnd,
                std::ptr::null(),
            );
            if selected != 0 {
                let position = ((point.y as u16 as u32) << 16 | point.x as u16 as u32) as isize;
                PostMessageW(hwnd, WM_SYSCOMMAND, selected as usize, position);
            }
        })
        .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn system_menu(_window: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{Action, TooltipBounds};

    #[test]
    fn tooltip_bounds_are_finite_and_viewport_bounded() {
        let valid = TooltipBounds {
            left: 600.0,
            top: 12.0,
            width: 192.0,
            height: 38.0,
            radius: 12.0,
            viewport_width: 800.0,
            viewport_height: 600.0,
        };
        assert!(valid.valid());
        for invalid in [
            TooltipBounds {
                left: -1.0,
                ..valid
            },
            TooltipBounds {
                width: 322.0,
                ..valid
            },
            TooltipBounds {
                height: 4097.0,
                ..valid
            },
            TooltipBounds {
                top: f64::NAN,
                ..valid
            },
            TooltipBounds {
                radius: f64::INFINITY,
                ..valid
            },
            TooltipBounds {
                viewport_width: 0.0,
                ..valid
            },
            TooltipBounds {
                left: 799.0,
                ..valid
            },
        ] {
            assert!(!invalid.valid());
        }
        assert!(serde_json::from_value::<TooltipBounds>(serde_json::json!({
            "left": 0, "top": 0, "width": 200, "height": 30, "radius": 12,
            "viewportWidth": 800, "viewportHeight": 600, "window": "settings"
        }))
        .is_err());
    }

    #[test]
    fn frame_actions_do_not_accept_arbitrary_commands_or_windows() {
        for action in ["minimize", "maximize", "close", "drag", "system-menu"] {
            assert!(serde_json::from_value::<Action>(serde_json::json!(action)).is_ok());
        }
        for action in ["exit", "destroy", "show", "eval", "resize"] {
            assert!(serde_json::from_value::<Action>(serde_json::json!(action)).is_err());
        }
    }
}
