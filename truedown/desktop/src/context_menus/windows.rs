//! Windows owns capture, keyboard navigation and dismissal; no popup WebView.
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Manager, WebviewWindow};
#[path = "windows_style.rs"]
mod style;
use windows_sys::Win32::{
    Foundation::{POINT, RECT},
    Graphics::Gdi::ClientToScreen,
    UI::{
        HiDpi::GetDpiForWindow, Input::KeyboardAndMouse::IsWindowEnabled, WindowsAndMessaging::*,
    },
};

#[derive(Default)]
pub struct Menus {
    // Win32 has one active menu loop on the application UI thread.
    active: Mutex<Option<Request>>,
    cancelled: Mutex<HashMap<String, u32>>,
}
struct Request {
    caller: String,
    id: u32,
    cancelled: Arc<AtomicBool>,
}
impl Menus {
    fn cancel(app: &tauri::AppHandle, token: Arc<AtomicBool>) {
        token.store(true, Ordering::SeqCst);
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let state = handle.state::<Menus>();
            let active = state.active.lock().unwrap();
            // An old queued cancellation must not dismiss a later menu.
            if active
                .as_ref()
                .is_some_and(|request| Arc::ptr_eq(&request.cancelled, &token))
            {
                unsafe {
                    EndMenu();
                }
            }
        });
    }
}
struct Cleanup {
    app: tauri::AppHandle,
    token: Arc<AtomicBool>,
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        Menus::cancel(&self.app, self.token.clone());
    }
}

#[tauri::command]
pub async fn show_context_menu(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: u32,
    keyboard: Option<bool>,
    actions: Vec<String>,
    x: f64,
    y: f64,
) -> Result<Option<String>, String> {
    super::validate(window.label(), &actions, x, y)?;
    if app.state::<crate::windows::Windows>().suppress {
        return Err("Native menus are suppressed during hidden acceptance".into());
    }
    let state = app.state::<Menus>();
    let token = Arc::new(AtomicBool::new(false));
    {
        let mut active = state.active.lock().unwrap();
        if active.is_some() {
            return Err("A context menu is already open".into());
        }
        if state.cancelled.lock().unwrap().get(window.label()) == Some(&request_id) {
            return Ok(None);
        }
        *active = Some(Request {
            caller: window.label().into(),
            id: request_id,
            cancelled: token.clone(),
        });
    }
    let _cleanup = Cleanup {
        app: app.clone(),
        token: token.clone(),
    };
    let handle = app.clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let scheduled = app.run_on_main_thread(move || {
        let result = if token.load(Ordering::SeqCst) || sender.is_closed() {
            Ok(None)
        } else {
            let _ = keyboard; // The OS tracks both mouse and keyboard invocation.
            unsafe { track(&window, &actions, x, y, &token) }
        };
        let state = handle.state::<Menus>();
        let mut active = state.active.lock().unwrap();
        if active
            .as_ref()
            .is_some_and(|request| Arc::ptr_eq(&request.cancelled, &token))
        {
            *active = None;
        }
        drop(active);
        let _ = sender.send(result);
    });
    if let Err(error) = scheduled {
        state.active.lock().unwrap().take();
        return Err(error.to_string());
    }
    receiver
        .await
        .map_err(|_| "Menu window closed".to_string())?
}

struct Menu(HMENU);
impl Drop for Menu {
    fn drop(&mut self) {
        unsafe {
            DestroyMenu(self.0);
        }
    }
}
unsafe fn track(
    window: &WebviewWindow,
    actions: &[String],
    x: f64,
    y: f64,
    cancelled: &AtomicBool,
) -> Result<Option<String>, String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
    if IsWindowVisible(hwnd) == 0 || IsWindowEnabled(hwnd) == 0 || GetForegroundWindow() != hwnd {
        return Err("Menus require a visible focused caller".into());
    }
    let menu = Menu(CreatePopupMenu());
    if menu.0.is_null() {
        return Err("Cannot create context menu".into());
    }
    for (index, action) in actions.iter().enumerate() {
        let label = label(action).ok_or("Unavailable menu action")?;
        let text: Vec<u16> = label.encode_utf16().chain(Some(0)).collect();
        if AppendMenuW(menu.0, MF_STRING, index + 1, text.as_ptr()) == 0 {
            return Err("Cannot create context menu item".into());
        }
    }
    let _style = style::attach(window, menu.0, actions)?;
    let scale = GetDpiForWindow(hwnd) as f64 / 96.0;
    let mut rect: RECT = std::mem::zeroed();
    if GetClientRect(hwnd, &mut rect) == 0 {
        return Err("Menu caller bounds unavailable".into());
    }
    let mut point = POINT {
        x: (x * scale).clamp(0.0, f64::from(rect.right.max(0))) as i32,
        y: (y * scale).clamp(0.0, f64::from(rect.bottom.max(0))) as i32,
    };
    if ClientToScreen(hwnd, &mut point) == 0 {
        return Err("Menu position unavailable".into());
    }
    let alignment = if GetSystemMetrics(SM_MENUDROPALIGNMENT) != 0 {
        TPM_RIGHTALIGN
    } else {
        TPM_LEFTALIGN
    };
    // Do not raise or focus windows: only the already-active owner can open it.
    let selected = TrackPopupMenuEx(
        menu.0,
        alignment | TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON,
        point.x,
        point.y,
        hwnd,
        std::ptr::null(),
    );
    if cancelled.load(Ordering::SeqCst)
        || IsWindowVisible(hwnd) == 0
        || GetForegroundWindow() != hwnd
    {
        return Ok(None);
    }
    Ok(selected
        .checked_sub(1)
        .and_then(|index| actions.get(index as usize))
        .cloned())
}

#[tauri::command]
pub fn context_menu_cancel(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: u32,
) -> Result<(), String> {
    crate::editing::authorize(window.label())?;
    let state = app.state::<Menus>();
    let token = {
        let active = state.active.lock().unwrap();
        state
            .cancelled
            .lock()
            .unwrap()
            .insert(window.label().into(), request_id);
        active
            .as_ref()
            .filter(|request| request.caller == window.label() && request.id == request_id)
            .map(|request| request.cancelled.clone())
    };
    if let Some(token) = token {
        Menus::cancel(&app, token);
    }
    Ok(())
}
// Keep the cross-platform IPC surface closed on Windows. Only HMENU can answer.
#[tauri::command]
pub fn context_menu_init() -> Option<Vec<String>> {
    None
}
#[tauri::command]
pub fn context_menu_ready() -> Result<(), String> {
    Err("Windows uses system menus".into())
}
#[tauri::command]
pub fn context_menu_answer(action: Option<String>) -> Result<(), String> {
    let _ = action;
    Err("Windows uses system menus".into())
}
#[tauri::command]
pub fn context_menu_key(
    window: WebviewWindow,
    request_id: u32,
    key: super::MenuKey,
) -> Result<(), String> {
    crate::editing::authorize(window.label())?;
    let _ = (request_id, key);
    Ok(()) // Windows consumes navigation keys inside TrackPopupMenuEx.
}

fn label(action: &str) -> Option<&'static str> {
    Some(match action {
        "details" => "\u{4efb}\u{52a1}\u{8be6}\u{60c5}",
        "pause" => "\u{6682}\u{505c}",
        "resume" => "\u{7ee7}\u{7eed}",
        "requeue" => "\u{91cd}\u{8bd5}",
        "open-file" => "\u{6253}\u{5f00}\u{6587}\u{4ef6}",
        "open-folder" => "\u{6253}\u{5f00}\u{4e0b}\u{8f7d}\u{76ee}\u{5f55}",
        "remove" => "\u{79fb}\u{9664}\u{4efb}\u{52a1}",
        "new-task" => "\u{65b0}\u{5efa}\u{4e0b}\u{8f7d}",
        "settings" => "\u{8bbe}\u{7f6e}",
        "group-show" => "\u{67e5}\u{770b}\u{6b64}\u{5206}\u{7ec4}",
        "group-edit" => "\u{8c03}\u{6574}\u{6b64}\u{5206}\u{7ec4}",
        "group-add" => "\u{65b0}\u{589e}\u{5206}\u{7ec4}",
        "group-manage" => "\u{7ba1}\u{7406}\u{5206}\u{7ec4}",
        "pause-queue" => "\u{6682}\u{505c}\u{6574}\u{4e2a}\u{961f}\u{5217}",
        "resume-queue" => "\u{6062}\u{590d}\u{6574}\u{4e2a}\u{961f}\u{5217}",
        "retry-all" => "\u{91cd}\u{8bd5}\u{6240}\u{6709}\u{5931}\u{8d25}\u{4efb}\u{52a1}",
        "clear-done" => "\u{6e05}\u{7406}\u{6240}\u{6709}\u{5df2}\u{5b8c}\u{6210}\u{8bb0}\u{5f55}",
        "open-downloads" => "\u{6253}\u{5f00}\u{9ed8}\u{8ba4}\u{4e0b}\u{8f7d}\u{76ee}\u{5f55}",
        "undo" => "\u{64a4}\u{9500}\tCtrl+Z",
        "redo" => "\u{91cd}\u{505a}\tCtrl+Y",
        "cut" => "\u{526a}\u{5207}\tCtrl+X",
        "copy" => "\u{590d}\u{5236}\tCtrl+C",
        "paste" => "\u{7c98}\u{8d34}\tCtrl+V",
        "select-all" => "\u{5168}\u{9009}\tCtrl+A",
        _ => return None,
    })
}
#[cfg(test)]
mod tests {
    #[test]
    fn every_offered_action_has_a_native_label() {
        for action in super::super::ACTIONS {
            assert!(super::label(action).is_some());
        }
        assert!(super::label("read-clipboard").is_none());
    }
}
