//! Fixed editing commands on the focused caller; clipboard contents stay native.
use tauri::Manager;

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Action {
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
}

pub fn authorize(role: &str) -> Result<(), String> {
    if ["main", "settings", "new-task", "task-details"].contains(&role) {
        Ok(())
    } else {
        Err("Editing is unavailable in this window".into())
    }
}

pub async fn run(window: tauri::WebviewWindow, action: Action) -> Result<(), String> {
    authorize(window.label())?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let caller = window.clone();
    window
        .with_webview(move |webview| {
            if sender.is_closed() {
                return;
            }
            let result = (|| {
                if caller.state::<crate::windows::Windows>().suppress {
                    return Err("Native editing is suppressed during hidden acceptance".into());
                }
                if !caller.is_visible().map_err(|error| error.to_string())?
                    || !caller.is_focused().map_err(|error| error.to_string())?
                {
                    return Err("Editing requires the focused window".into());
                }
                execute(&caller, webview, action)
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "Editing window closed".to_string())?
}

#[cfg(windows)]
fn execute(
    window: &tauri::WebviewWindow,
    _: tauri::webview::PlatformWebview,
    action: Action,
) -> Result<(), String> {
    use windows_sys::Win32::UI::{
        Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_KEYBOARD, KEYEVENTF_KEYUP, VK_CONTROL},
        WindowsAndMessaging::GetForegroundWindow,
    };
    let key = match action {
        Action::Undo => 0x5A,
        Action::Redo => 0x59,
        Action::Cut => 0x58,
        Action::Copy => 0x43,
        Action::Paste => 0x56,
        Action::SelectAll => 0x41,
    };
    unsafe {
        // Match native menu editing without reading or returning the clipboard.
        if GetForegroundWindow() != window.hwnd().map_err(|error| error.to_string())?.0 {
            return Err("Editing requires the foreground window".into());
        }
        let mut inputs: [INPUT; 4] = std::mem::zeroed();
        for (input, (key, flags)) in inputs.iter_mut().zip([
            (VK_CONTROL, 0),
            (key, 0),
            (key, KEYEVENTF_KEYUP),
            (VK_CONTROL, KEYEVENTF_KEYUP),
        ]) {
            input.r#type = INPUT_KEYBOARD;
            input.Anonymous.ki.wVk = key;
            input.Anonymous.ki.dwFlags = flags;
        }
        if SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        ) != inputs.len() as u32
        {
            return Err("Cannot dispatch editing command".into());
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn execute(
    _: &tauri::WebviewWindow,
    webview: tauri::webview::PlatformWebview,
    action: Action,
) -> Result<(), String> {
    use webkit2gtk::WebViewExt;
    webview.inner().execute_editing_command(match action {
        Action::Undo => "Undo",
        Action::Redo => "Redo",
        Action::Cut => "Cut",
        Action::Copy => "Copy",
        Action::Paste => "Paste",
        Action::SelectAll => "SelectAll",
    });
    Ok(())
}

#[cfg(target_os = "macos")]
fn execute(
    _: &tauri::WebviewWindow,
    webview: tauri::webview::PlatformWebview,
    action: Action,
) -> Result<(), String> {
    use objc2::{msg_send, runtime::AnyObject};
    // These are WKWebView's standard responder actions, on its owning thread.
    let view = webview.inner().cast::<AnyObject>();
    let sender = std::ptr::null::<AnyObject>();
    unsafe {
        match action {
            Action::Undo => {
                let manager: *mut AnyObject = msg_send![view, undoManager];
                if !manager.is_null() {
                    let _: () = msg_send![manager, undo];
                }
            }
            Action::Redo => {
                let manager: *mut AnyObject = msg_send![view, undoManager];
                if !manager.is_null() {
                    let _: () = msg_send![manager, redo];
                }
            }
            Action::Cut => {
                let _: () = msg_send![view, cut: sender];
            }
            Action::Copy => {
                let _: () = msg_send![view, copy: sender];
            }
            Action::Paste => {
                let _: () = msg_send![view, paste: sender];
            }
            Action::SelectAll => {
                let _: () = msg_send![view, selectAll: sender];
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn editing_accepts_only_known_roles_and_actions() {
        for role in ["main", "settings", "new-task", "task-details"] {
            assert!(authorize(role).is_ok());
        }
        assert!(authorize("other").is_err());
        for action in ["undo", "redo", "cut", "copy", "paste", "select-all"] {
            assert!(serde_json::from_value::<Action>(serde_json::json!(action)).is_ok());
        }
        assert!(serde_json::from_value::<Action>(serde_json::json!("read-clipboard")).is_err());
    }
}
