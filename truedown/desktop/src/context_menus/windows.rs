//! WebView keyboard focus can move while a non-activating menu leaves its owner foreground.
use windows_sys::Win32::UI::{
    Input::KeyboardAndMouse::{GetFocus, SetFocus},
    WindowsAndMessaging::{GetForegroundWindow, IsChild, IsWindow},
};

pub fn is_active(window: &tauri::WebviewWindow) -> bool {
    window
        .hwnd()
        .is_ok_and(|hwnd| unsafe { GetForegroundWindow() == hwnd.0 })
}

pub struct CallerFocus {
    parent: usize,
    editor: usize,
}

impl CallerFocus {
    // Run on the owning UI thread after destroying the popup; never raise a background caller.
    pub fn restore(&self) {
        let parent = self.parent as _;
        let editor = self.editor as _;
        unsafe {
            if GetForegroundWindow() == parent
                && IsWindow(editor) != 0
                && (editor == parent || IsChild(parent, editor) != 0)
            {
                SetFocus(editor);
            }
        }
    }
}

pub async fn capture(window: &tauri::WebviewWindow) -> Result<CallerFocus, String> {
    let caller = window.clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread(move || {
            let result = (|| {
                let parent = caller.hwnd().map_err(|error| error.to_string())?.0;
                let editor = unsafe { GetFocus() };
                if unsafe {
                    GetForegroundWindow() != parent
                        || (editor != parent && IsChild(parent, editor) == 0)
                } {
                    return Err("Menu caller lost focus".into());
                }
                Ok(CallerFocus {
                    parent: parent as usize,
                    editor: editor as usize,
                })
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "Menu window closed".to_string())?
}
