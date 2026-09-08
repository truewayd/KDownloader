//! Bounded operations on the calling window's custom title bar. The operating
//! system still owns resizing, snapping, minimize/restore and the system menu.
use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewWindow, WebviewWindowBuilder, Wry};

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
    builder.decorations(false).shadow(true)
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
            if window.is_maximized().map_err(|error| error.to_string())? {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        // Closing the frame is the same hide-to-tray action as Alt+F4. It must
        // never stop the core or destroy an auxiliary window's unsaved draft.
        Action::Close => window.hide(),
        Action::Drag => window.start_dragging(),
        Action::SystemMenu => return system_menu(&window),
    }
    .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn system_menu(window: &WebviewWindow) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{PostMessageW, SC_KEYMENU, WM_SYSCOMMAND};
    let handle = window.hwnd().map_err(|error| error.to_string())?;
    // Let DefWindowProc place and operate the genuine system menu. Posting
    // avoids holding an IPC response open for the lifetime of the menu loop.
    if unsafe { PostMessageW(handle.0, WM_SYSCOMMAND, SC_KEYMENU as usize, 0x20) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

#[cfg(not(windows))]
fn system_menu(_window: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::Action;

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
