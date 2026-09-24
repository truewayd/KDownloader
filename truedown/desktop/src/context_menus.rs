//! Independent, caller-owned menu windows. No clipboard data or task payload crosses IPC.
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Manager, WebviewWindow};
use tokio::sync::oneshot;

const ACTIONS: &[&str] = &[
    "details",
    "pause",
    "resume",
    "requeue",
    "open-file",
    "open-folder",
    "remove",
    "new-task",
    "settings",
    "undo",
    "redo",
    "cut",
    "copy",
    "paste",
    "select-all",
];
const EDITING: &[&str] = &["undo", "redo", "cut", "copy", "paste", "select-all"];

#[derive(Default)]
pub struct Menus {
    pending: Mutex<HashMap<String, Pending>>,
    sequence: AtomicU64,
    slots: [Arc<tokio::sync::Mutex<()>>; 4],
    cancelled: Mutex<HashMap<String, u32>>,
}
struct Pending {
    parent: WebviewWindow,
    request_id: u32,
    actions: Vec<String>,
    sender: oneshot::Sender<Option<String>>,
    ready: bool,
    focused: bool,
    _slot: tokio::sync::OwnedMutexGuard<()>,
}

fn validate(role: &str, actions: &[String], x: f64, y: f64) -> Result<(), String> {
    crate::editing::authorize(role)?;
    if actions.is_empty()
        || actions.len() > ACTIONS.len()
        || !x.is_finite()
        || !y.is_finite()
        || x.abs() > 32768.0
        || y.abs() > 32768.0
    {
        return Err("Invalid context menu".into());
    }
    for (index, action) in actions.iter().enumerate() {
        if !ACTIONS.contains(&action.as_str())
            || actions[..index].contains(action)
            || (role != "main" && !EDITING.contains(&action.as_str()))
        {
            return Err("Unavailable menu action".into());
        }
    }
    Ok(())
}

impl Menus {
    fn finish(&self, app: &tauri::AppHandle, label: &str, action: Option<String>) {
        let entry = self.pending.lock().unwrap().remove(label);
        if let Some(entry) = entry {
            let popup = app.get_webview_window(label);
            let _ = app.run_on_main_thread(move || {
                let restore = action.is_some()
                    || popup
                        .as_ref()
                        .is_some_and(|p| p.is_focused().unwrap_or(false));
                if let Some(popup) = popup {
                    let _ = popup.destroy();
                }
                if restore && entry.parent.is_visible().unwrap_or(false) {
                    let _ = entry.parent.set_focus();
                }
                let _ = entry.sender.send(action);
                drop(entry._slot);
            });
        }
    }
}
struct Cleanup {
    app: tauri::AppHandle,
    label: String,
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        self.app
            .state::<Menus>()
            .finish(&self.app, &self.label, None);
    }
}

#[tauri::command]
pub async fn show_context_menu(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: u32,
    actions: Vec<String>,
    x: f64,
    y: f64,
) -> Result<Option<String>, String> {
    validate(window.label(), &actions, x, y)?;
    if app.state::<crate::windows::Windows>().suppress {
        return Err("Native menus are suppressed during hidden acceptance".into());
    }
    if !window.is_visible().unwrap_or(false) || !window.is_focused().unwrap_or(false) {
        return Err("Menus require a visible focused caller".into());
    }
    let state = app.state::<Menus>();
    let role = match window.label() {
        "main" => 0,
        "settings" => 1,
        "new-task" => 2,
        "task-details" => 3,
        _ => unreachable!(),
    };
    let slot = state.slots[role]
        .clone()
        .try_lock_owned()
        .map_err(|_| "A context menu is already open")?;
    if state.cancelled.lock().unwrap().get(window.label()) == Some(&request_id) {
        return Ok(None);
    }
    let label = format!(
        "context-menu-{}-{}",
        window.label(),
        state.sequence.fetch_add(1, Ordering::Relaxed)
    );
    let (sender, mut receiver) = oneshot::channel();
    let height = actions.len() as f64 * 34.0 + 12.0;
    {
        let mut pending = state.pending.lock().unwrap();
        if pending.values().any(|p| p.parent.label() == window.label()) {
            return Err("A context menu is already open".into());
        }
        pending.insert(
            label.clone(),
            Pending {
                parent: window.clone(),
                request_id,
                actions,
                sender,
                ready: false,
                focused: false,
                _slot: slot,
            },
        );
    }
    let _cleanup = Cleanup {
        app: app.clone(),
        label: label.clone(),
    };
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let origin = window.inner_position().map_err(|e| e.to_string())?;
    let parent_size = window.inner_size().map_err(|e| e.to_string())?;
    let pointer_x = origin.x as f64 + (x * scale).clamp(0.0, parent_size.width as f64);
    let pointer_y = origin.y as f64 + (y * scale).clamp(0.0, parent_size.height as f64);
    let monitor = window
        .monitor_from_point(pointer_x, pointer_y)
        .map_err(|e| e.to_string())?
        .ok_or("Menu monitor unavailable")?;
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let width = (256.0 * scale).min(area.size.width as f64);
    let height = (height * scale).min(area.size.height as f64);
    let left = pointer_x.clamp(
        area.position.x as f64,
        area.position.x as f64 + area.size.width as f64 - width,
    );
    let top = pointer_y.clamp(
        area.position.y as f64,
        area.position.y as f64 + area.size.height as f64 - height,
    );
    let popup = app
        .state::<crate::windows::Windows>()
        .storage
        .configure(tauri::WebviewWindowBuilder::new(
            &app,
            &label,
            tauri::WebviewUrl::App("context-menu-window.html".into()),
        ))
        .parent(&window)
        .map_err(|e| e.to_string())?
        .title("TrueDown menu")
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .shadow(true)
        .visible(false)
        .focused(false)
        .inner_size(width / scale, height / scale)
        .on_navigation(crate::windows::local_navigation)
        .build()
        .map_err(|e| e.to_string())?;
    popup
        .set_size(tauri::PhysicalSize::new(width as u32, height as u32))
        .map_err(|e| e.to_string())?;
    popup
        .set_position(tauri::PhysicalPosition::new(left as i32, top as i32))
        .map_err(|e| e.to_string())?;
    let handle = app.clone();
    let event_label = label.clone();
    popup.on_window_event(move |event| {
        let state = handle.state::<Menus>();
        let close = match event {
            tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => true,
            tauri::WindowEvent::Focused(focused) => {
                let mut pending = state.pending.lock().unwrap();
                if let Some(entry) = pending.get_mut(&event_label) {
                    let close = !focused && entry.focused;
                    entry.focused |= focused;
                    close
                } else {
                    false
                }
            }
            _ => false,
        };
        if close {
            state.finish(&handle, &event_label, None);
        }
    });
    let started = std::time::Instant::now();
    loop {
        match tokio::time::timeout(std::time::Duration::from_millis(150), &mut receiver).await {
            Ok(result) => return result.map_err(|_| "Menu closed without a result".into()),
            Err(_) => {
                if !window.is_visible().unwrap_or(false)
                    || window.inner_position().ok() != Some(origin)
                    || window.inner_size().ok() != Some(parent_size)
                {
                    return Ok(None);
                }
                let ready = state
                    .pending
                    .lock()
                    .unwrap()
                    .get(&label)
                    .is_some_and(|p| p.ready);
                if !ready && started.elapsed() > std::time::Duration::from_secs(15) {
                    return Err("Menu window did not initialize".into());
                }
            }
        }
    }
}

#[tauri::command]
pub fn context_menu_init(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Vec<String>, String> {
    app.state::<Menus>()
        .pending
        .lock()
        .unwrap()
        .get(window.label())
        .map(|p| p.actions.clone())
        .ok_or_else(|| "Unknown menu window".into())
}
#[tauri::command]
pub fn context_menu_ready(app: tauri::AppHandle, window: WebviewWindow) -> Result<(), String> {
    let state = app.state::<Menus>();
    {
        let mut pending = state.pending.lock().unwrap();
        let entry = pending
            .get_mut(window.label())
            .ok_or("Unknown menu window")?;
        if entry.ready {
            return Ok(());
        }
        if !entry.parent.is_visible().unwrap_or(false) {
            return Err("Caller hidden".into());
        }
    }
    let result = window.show().and_then(|_| window.set_focus()).map_err(|e| e.to_string());
    if result.is_err() { state.finish(&app, window.label(), None); }
    else if let Some(entry) = state.pending.lock().unwrap().get_mut(window.label()) { entry.ready = true; }
    result
}
#[tauri::command]
pub fn context_menu_answer(
    app: tauri::AppHandle,
    window: WebviewWindow,
    action: Option<String>,
) -> Result<(), String> {
    let state = app.state::<Menus>();
    {
        let pending = state.pending.lock().unwrap();
        let entry = pending.get(window.label()).ok_or("Unknown menu window")?;
        if !entry.ready || action.as_ref().is_some_and(|a| !entry.actions.contains(a)) {
            return Err("Unavailable menu action".into());
        }
    }
    state.finish(&app, window.label(), action);
    Ok(())
}
#[tauri::command]
pub fn context_menu_cancel(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: u32,
) -> Result<(), String> {
    crate::editing::authorize(window.label())?;
    let state = app.state::<Menus>();
    state
        .cancelled
        .lock()
        .unwrap()
        .insert(window.label().to_string(), request_id);
    let labels: Vec<_> = state
        .pending
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, p)| p.parent.label() == window.label() && p.request_id == request_id)
        .map(|(label, _)| label.clone())
        .collect();
    for label in labels {
        state.finish(&app, &label, None);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roles_actions_duplicates_and_coordinates_are_bounded() {
        assert!(validate("main", &["settings".into()], 10.0, 10.0).is_ok());
        assert!(validate("settings", &["settings".into()], 0.0, 0.0).is_err());
        assert!(validate("settings", &["copy".into()], 0.0, 0.0).is_ok());
        assert!(validate("context-menu-main-0", &["copy".into()], 0.0, 0.0).is_err());
        assert!(validate("main", &["copy".into(), "copy".into()], 0.0, 0.0).is_err());
        assert!(validate("main", &["copy".into()], f64::NAN, 0.0).is_err());
        assert!(validate("main", &["exit".into()], 0.0, 0.0).is_err());
    }
}
