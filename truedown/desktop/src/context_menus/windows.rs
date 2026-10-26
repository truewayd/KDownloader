//! Shared retained Composition menus; HMENU remains the accessibility fallback.
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Manager, WebviewWindow};
#[path = "windows_style.rs"]
mod style;
#[path = "windows_tracking.rs"]
mod tracking;
use windows_sys::Win32::{
    Foundation::{POINT, RECT},
    Graphics::Gdi::ClientToScreen,
    UI::{
        Accessibility::{HCF_HIGHCONTRASTON, HIGHCONTRASTW},
        HiDpi::{
            GetDpiForWindow, GetWindowDpiAwarenessContext, SetThreadDpiAwarenessContext,
            DPI_AWARENESS_CONTEXT,
        },
        Input::KeyboardAndMouse::IsWindowEnabled,
        WindowsAndMessaging::*,
    },
};

#[derive(Default)]
pub struct Menus {
    // Win32 has one active menu loop on the application UI thread.
    active: Mutex<Option<Request>>,
    cancelled: Mutex<HashMap<String, u32>>,
    generation: AtomicU64,
    idle: tokio::sync::Notify,
}
struct Request {
    caller: String,
    id: u32,
    cancelled: Arc<AtomicBool>,
}
impl Menus {
    async fn reserve(
        &self,
        app: &tauri::AppHandle,
        caller: &str,
        id: u32,
    ) -> Option<Arc<AtomicBool>> {
        let generation = self
            .generation
            .fetch_add(1, Ordering::SeqCst)
            .wrapping_add(1);
        self.idle.notify_waiters();
        loop {
            let notified = self.idle.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let previous = {
                let mut active = self.active.lock().unwrap();
                if self.generation.load(Ordering::SeqCst) != generation
                    || self.cancelled.lock().unwrap().get(caller) == Some(&id)
                {
                    return None;
                }
                if let Some(request) = active.as_ref() {
                    request.cancelled.clone()
                } else {
                    let token = Arc::new(AtomicBool::new(false));
                    *active = Some(Request {
                        caller: caller.into(),
                        id,
                        cancelled: token.clone(),
                    });
                    return Some(token);
                }
            };
            // Complete the old native loop before another content/tray menu can
            // reuse its HWND. Newer requests supersede waiting ones without polling.
            Self::cancel(app, previous);
            notified.await;
        }
    }
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
                    truedown_native_menu::dismiss();
                    style::dismiss();
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
    let Some(token) = state.reserve(&app, window.label(), request_id).await else {
        return Ok(None);
    };
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
            unsafe { track(&window, &actions, x, y, &token, keyboard.unwrap_or(false)) }
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
        state.idle.notify_waiters();
        let _ = sender.send(result);
    });
    if let Err(error) = scheduled {
        state.active.lock().unwrap().take();
        state.idle.notify_waiters();
        return Err(error.to_string());
    }
    receiver
        .await
        .map_err(|_| "Menu window closed".to_string())?
}

struct Menu(HMENU);
struct DpiContext(DPI_AWARENESS_CONTEXT);
impl Drop for DpiContext {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                SetThreadDpiAwarenessContext(self.0);
            }
        }
    }
}
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
    keyboard: bool,
) -> Result<Option<String>, String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
    if IsWindowVisible(hwnd) == 0 || IsWindowEnabled(hwnd) == 0 || GetForegroundWindow() != hwnd {
        return Err("Menus require a visible focused caller".into());
    }
    // Measure, place and track in the caller's coordinate space, even if another
    // native dialog temporarily changed this UI thread's DPI awareness.
    let context = GetWindowDpiAwarenessContext(hwnd);
    let _dpi = DpiContext(if context.is_null() {
        std::ptr::null_mut()
    } else {
        SetThreadDpiAwarenessContext(context)
    });
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
    track_at(window, hwnd, actions, point, cancelled, true, keyboard)
}

unsafe fn track_at(
    window: &WebviewWindow,
    hwnd: windows_sys::Win32::Foundation::HWND,
    actions: &[String],
    point: POINT,
    cancelled: &AtomicBool,
    visible_owner: bool,
    keyboard: bool,
) -> Result<Option<String>, String> {
    // Keep USER32 accessibility and scrolling on the fallback route. Only native
    // allowlisted labels/icons reach Composition; the WebView supplies no pixels.
    if !keyboard && composition_allowed() {
        match truedown_native_menu::track(
            hwnd as isize,
            (point.x, point.y),
            window.theme().ok() == Some(tauri::Theme::Dark),
            visible_owner,
            actions,
            cancelled,
            || composition_model(actions),
        ) {
            Ok(selected) => {
                return Ok(selected
                    .filter(|_| {
                        !cancelled.load(Ordering::SeqCst)
                            && IsWindow(hwnd) != 0
                            && GetForegroundWindow() == hwnd
                            && (!visible_owner
                                || (IsWindowVisible(hwnd) != 0 && IsWindowEnabled(hwnd) != 0))
                    })
                    .and_then(|index| actions.get(index))
                    .cloned())
            }
            Err(error) => eprintln!("[native-menu] Composition unavailable; using HMENU: {error}"),
        }
    }
    if cancelled.load(Ordering::SeqCst) {
        return Ok(None);
    }
    let menu = Menu(CreatePopupMenu());
    if menu.0.is_null() {
        return Err("Cannot create context menu".into());
    }
    for (index, action) in actions.iter().enumerate() {
        let text: Vec<u16> = label(action)
            .ok_or("Unavailable menu action")?
            .encode_utf16()
            .chain(Some(0))
            .collect();
        if AppendMenuW(menu.0, MF_STRING, index + 1, text.as_ptr()) == 0 {
            return Err("Cannot create context menu item".into());
        }
    }
    let _style = style::attach(window, hwnd, menu.0, actions)?;
    let tracking = tracking::Tracking::attach(menu.0, hwnd, actions.len(), visible_owner)?;
    let selected = TrackPopupMenuEx(
        menu.0,
        TPM_LEFTALIGN
            | TPM_WORKAREA
            | TPM_NOANIMATION
            | TPM_RETURNCMD
            | TPM_NONOTIFY
            | TPM_RIGHTBUTTON,
        point.x,
        point.y,
        hwnd,
        std::ptr::null(),
    );
    let selected = tracking.selected(selected as u32, cancelled.load(Ordering::SeqCst));
    Ok(selected
        .checked_sub(1)
        .and_then(|index| actions.get(index as usize))
        .cloned())
}

unsafe fn composition_allowed() -> bool {
    let mut contrast = HIGHCONTRASTW {
        cbSize: std::mem::size_of::<HIGHCONTRASTW>() as u32,
        ..Default::default()
    };
    let mut reader = 0i32;
    SystemParametersInfoW(
        SPI_GETHIGHCONTRAST,
        contrast.cbSize,
        (&mut contrast as *mut HIGHCONTRASTW).cast(),
        0,
    ) != 0
        && contrast.dwFlags & HCF_HIGHCONTRASTON == 0
        && SystemParametersInfoW(SPI_GETSCREENREADER, 0, (&mut reader as *mut i32).cast(), 0) != 0
        && reader == 0
}

fn composition_model(actions: &[String]) -> Result<truedown_native_menu::Model, String> {
    use truedown_native_menu::{
        style::{ITEM_INSET, ROW_HEIGHT},
        Icon, Item, Model,
    };
    let mut model = Model {
        width: 256.,
        height: 0.,
        row_height: ROW_HEIGHT,
        items: Vec::with_capacity(actions.len()),
        tops: Vec::with_capacity(actions.len()),
        separators: vec![],
    };
    let mut top = ITEM_INSET;
    for (index, action) in actions.iter().enumerate() {
        let text = label(action).ok_or("Unavailable menu action")?;
        let (label, shortcut) = text.split_once('\t').unwrap_or((text, ""));
        let danger = matches!(action.as_str(), "remove" | "clear-done");
        if (danger || action == "tray-exit") && index > 0 {
            model.separators.push(top + 4.);
            top += 9.;
        }
        let image = style::icon(action, true)?;
        model.width = model.width.max(
            label.chars().count() as f32 * 14. + 64. + if shortcut.is_empty() { 0. } else { 84. },
        );
        model.tops.push(top);
        model.items.push(Item {
            label: label.into(),
            shortcut: shortcut.into(),
            danger,
            icon: Icon::Rgba {
                pixels: image.rgba().to_vec(),
                width: image.width(),
                height: image.height(),
            },
        });
        top += model.row_height;
    }
    model.height = top + ITEM_INSET;
    Ok(model)
}

// Native-only tray entry: these actions are never accepted from a WebView.
pub async fn show_tray_menu(
    app: &tauri::AppHandle,
    x: f64,
    y: f64,
) -> Result<Option<String>, String> {
    if app.state::<crate::windows::Windows>().suppress {
        return Ok(None);
    }
    let window = app
        .get_webview_window("main")
        .ok_or("Main window unavailable")?;
    let state = app.state::<Menus>();
    let Some(token) = state.reserve(app, "tray", 0).await else {
        return Ok(None);
    };
    let _cleanup = Cleanup {
        app: app.clone(),
        token: token.clone(),
    };
    let handle = app.clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    if let Err(error) = app.run_on_main_thread(move || {
        let result = if token.load(Ordering::SeqCst) || sender.is_closed() {
            Ok(None)
        } else {
            unsafe { track_tray(&window, x, y, &token) }
        };
        let state = handle.state::<Menus>();
        state.active.lock().unwrap().take();
        state.idle.notify_waiters();
        let _ = sender.send(result);
    }) {
        state.active.lock().unwrap().take();
        state.idle.notify_waiters();
        return Err(error.to_string());
    }
    receiver
        .await
        .map_err(|_| "Menu window closed".to_string())?
}

struct TrayOwner(windows_sys::Win32::Foundation::HWND);
impl Drop for TrayOwner {
    fn drop(&mut self) {
        unsafe {
            DestroyWindow(self.0);
        }
    }
}
thread_local! {
    static TRAY_OWNER: std::cell::RefCell<Option<TrayOwner>> = const { std::cell::RefCell::new(None) };
}
unsafe fn tray_owner() -> Result<windows_sys::Win32::Foundation::HWND, String> {
    TRAY_OWNER.with(|slot| {
        let mut slot = slot.borrow_mut();
        if let Some(owner) = slot.as_ref() {
            return Ok(owner.0);
        }
        // A dedicated hidden top-level owner lets the tray work with every product
        // window hidden, without raising the main window just to display a menu.
        let owner = TrayOwner(CreateWindowExW(
            WS_EX_TOOLWINDOW,
            windows_sys::w!("STATIC"),
            windows_sys::w!("TrueDown tray menu"),
            WS_POPUP,
            0,
            0,
            0,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null(),
        ));
        if owner.0.is_null() {
            return Err("Cannot create tray menu owner".into());
        }
        let hwnd = owner.0;
        *slot = Some(owner);
        Ok(hwnd)
    })
}
unsafe fn track_tray(
    window: &WebviewWindow,
    x: f64,
    y: f64,
    token: &AtomicBool,
) -> Result<Option<String>, String> {
    let owner = tray_owner()?;
    if SetForegroundWindow(owner) == 0 {
        return Err("Cannot activate tray menu".into());
    }
    let actions = ["tray-new", "tray-open", "settings", "tray-exit"].map(str::to_string);
    let result = track_at(
        window,
        owner,
        &actions,
        POINT {
            x: x as i32,
            y: y as i32,
        },
        token,
        false,
        false,
    );
    // Required by the notification-area menu lifecycle for reliable dismissal.
    PostMessageW(owner, WM_NULL, 0, 0);
    result
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
    state.idle.notify_waiters();
    Ok(())
}
// Only the native tracking loop can answer; a WebView cannot choose an action.
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
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: u32,
    key: super::MenuKey,
) -> Result<(), String> {
    crate::editing::authorize(window.label())?;
    let caller = window.label().to_string();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let state = handle.state::<Menus>();
        let active = state.active.lock().unwrap();
        if active.as_ref().is_some_and(|r| {
            r.caller == caller && r.id == request_id && !r.cancelled.load(Ordering::SeqCst)
        }) {
            truedown_native_menu::key(match key {
                super::MenuKey::ArrowDown => 0x28,
                super::MenuKey::ArrowUp => 0x26,
                super::MenuKey::Home => 0x24,
                super::MenuKey::End => 0x23,
                super::MenuKey::Enter => 0x0d,
                super::MenuKey::Space => 0x20,
            });
        }
    })
    .map_err(|e| e.to_string())
}

fn label(action: &str) -> Option<&'static str> {
    Some(match action {
        "copy-link" => "复制下载地址",
        "preview" => "预览文件",
        "details" => "\u{4efb}\u{52a1}\u{8be6}\u{60c5}",
        "pause" => "\u{6682}\u{505c}",
        "resume" => "\u{7ee7}\u{7eed}",
        "requeue" => "\u{91cd}\u{8bd5}",
        "open-file" => "\u{6253}\u{5f00}\u{6587}\u{4ef6}",
        "open-folder" => "\u{6253}\u{5f00}\u{4e0b}\u{8f7d}\u{76ee}\u{5f55}",
        "remove" => "\u{79fb}\u{9664}\u{4efb}\u{52a1}",
        "new-task" => "\u{65b0}\u{5efa}\u{4e0b}\u{8f7d}",
        "settings" => "\u{8bbe}\u{7f6e}",
        "tray-new" => "\u{65b0}\u{5efa}",
        "tray-open" => "\u{6253}\u{5f00}",
        "tray-exit" => "\u{9000}\u{51fa}",
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
        for action in ["tray-new", "tray-open", "tray-exit"] {
            assert!(super::label(action).is_some());
        }
        assert!(super::label("read-clipboard").is_none());
    }
}
