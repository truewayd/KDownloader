use std::sync::Arc;
use tauri::{Manager, WebviewWindow};
use tokio::sync::{oneshot, Mutex};

#[derive(Default)]
pub struct Confirmations {
    slots: [Arc<Mutex<()>>; 4],
    pending: std::sync::Mutex<std::collections::HashMap<String, Pending>>,
    cancellations: std::sync::Mutex<std::collections::HashMap<String, u64>>,
}

struct Pending {
    parent: WebviewWindow,
    options: Options,
    sender: oneshot::Sender<bool>,
    _slot: tokio::sync::OwnedMutexGuard<()>,
    ready: bool,
    activated: bool,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    title: String,
    message: String,
    confirm_label: String,
    cancel_label: String,
    kind: Kind,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Info,
    Warning,
    Error,
}

impl Options {
    fn validate(&self) -> Result<(), String> {
        for (text, limit) in [
            (&self.title, 160),
            (&self.message, 8192),
            (&self.confirm_label, 80),
            (&self.cancel_label, 80),
        ] {
            if text.trim().is_empty() || text.len() > limit || text.contains('\0') {
                return Err("Invalid confirmation text".into());
            }
        }
        if self.confirm_label == self.cancel_label {
            return Err("Confirmation buttons must differ".into());
        }
        for text in [&self.title, &self.confirm_label, &self.cancel_label] {
            if text.chars().any(char::is_control) {
                return Err("Invalid confirmation label".into());
            }
        }
        Ok(())
    }
}

impl Confirmations {
    fn slot(&self, role: &str) -> Result<&Arc<Mutex<()>>, String> {
        let index = match role {
            "main" => 0,
            "settings" => 1,
            "new-task" => 2,
            "task-details" => 3,
            _ => return Err("Confirmations are unavailable in this window".into()),
        };
        Ok(&self.slots[index])
    }

    pub async fn show(
        &self,
        app: tauri::AppHandle,
        window: WebviewWindow,
        options: Options,
    ) -> Result<bool, String> {
        options.validate()?;
        if app.state::<crate::windows::Windows>().suppress {
            return Err("Native dialogs are suppressed during hidden acceptance".into());
        }
        let pending = self
            .slot(window.label())?
            .clone()
            .try_lock_owned()
            .map_err(|_| "A confirmation is already open for this window")?;
        let (sender, receiver) = oneshot::channel();
        let cancellation = self
            .cancellations
            .lock()
            .unwrap()
            .get(window.label())
            .copied();
        let popup = app
            .state::<crate::popup_cache::Cache>()
            .take(&app, &window, crate::popup_cache::Kind::Confirmation)
            .await?;
        let label = popup.label().to_string();
        if self
            .cancellations
            .lock()
            .unwrap()
            .get(window.label())
            .copied()
            != cancellation
        {
            let _ = popup.destroy();
            return Ok(false);
        }
        let title = options.title.clone();
        self.pending.lock().unwrap().insert(
            label.clone(),
            Pending {
                parent: window.clone(),
                options,
                sender,
                _slot: pending,
                ready: false,
                activated: false,
            },
        );
        let _cleanup = Cleanup {
            app: app.clone(),
            label: label.clone(),
        };
        popup.set_title(&title).map_err(|e| e.to_string())?;
        let handle = app.clone();
        let event_label = label.clone();
        popup.on_window_event(move |event| {
            if matches!(
                event,
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
            ) {
                handle
                    .state::<Confirmations>()
                    .finish(&handle, &event_label, false);
            }
        });
        if let Some(entry) = self.pending.lock().unwrap().get_mut(&label) {
            entry.activated = true;
        }
        popup
            .eval("window.refreshConfirmation?.()")
            .map_err(|e| e.to_string())?;
        let mut receiver = receiver;
        let started = std::time::Instant::now();
        loop {
            match tokio::time::timeout(std::time::Duration::from_millis(200), &mut receiver).await {
                Ok(answer) => {
                    return answer.map_err(|_| "Confirmation closed without a result".into())
                }
                Err(_) => {
                    let suppress = app.state::<crate::windows::Windows>().suppress;
                    if !suppress && !window.is_visible().unwrap_or(false) {
                        return Ok(false);
                    }
                    let ready = self
                        .pending
                        .lock()
                        .unwrap()
                        .get(&label)
                        .is_some_and(|p| p.ready);
                    if !ready && started.elapsed() > std::time::Duration::from_secs(15) {
                        return Err("Confirmation window did not initialize".into());
                    }
                }
            }
        }
    }

    fn finish(&self, app: &tauri::AppHandle, label: &str, accepted: bool) {
        let entry = self.pending.lock().unwrap().remove(label);
        if let Some(entry) = entry {
            let popup = app.get_webview_window(label);
            let _ = app.run_on_main_thread(move || {
                if let Some(popup) = popup {
                    let _ = popup.destroy();
                }
                let _ = entry.parent.set_enabled(true);
                if entry.parent.is_visible().unwrap_or(false) {
                    let _ = entry.parent.set_focus();
                }
                let _ = entry.sender.send(accepted);
                // Keep the slot until the native window is gone and its parent is restored.
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
            .state::<Confirmations>()
            .finish(&self.app, &self.label, false);
    }
}

#[tauri::command]
pub fn confirmation_init(app: tauri::AppHandle, window: WebviewWindow) -> Option<Options> {
    app.state::<Confirmations>()
        .pending
        .lock()
        .unwrap()
        .get(window.label())
        .filter(|entry| entry.activated)
        .map(|entry| entry.options.clone())
}

#[tauri::command]
pub fn confirmation_ready(
    app: tauri::AppHandle,
    window: WebviewWindow,
    height: u32,
) -> Result<(), String> {
    if !(144..=420).contains(&height) {
        return Err("Invalid confirmation height".into());
    }
    let state = app.state::<Confirmations>();
    let parent = {
        let mut pending = state.pending.lock().unwrap();
        let entry = pending
            .get_mut(window.label())
            .ok_or("Unknown confirmation window")?;
        if entry.ready {
            return Ok(());
        }
        entry.parent.clone()
    };
    let result = (|| {
        if !app.state::<crate::windows::Windows>().suppress {
            if !parent.is_visible().map_err(|e| e.to_string())? {
                return Err("Parent window is hidden".into());
            }
            let monitor = parent
                .current_monitor()
                .map_err(|e| e.to_string())?
                .ok_or("Confirmation monitor unavailable")?;
            let scale = monitor.scale_factor();
            let area = monitor.work_area();
            let width = (440.0_f64 * scale)
                .min(area.size.width as f64 - 32.0 * scale)
                .max(1.0);
            let height = (height as f64 * scale)
                .min(area.size.height as f64 - 64.0 * scale)
                .max(1.0);
            window
                .set_size(tauri::PhysicalSize::new(width as u32, height as u32))
                .map_err(|e| e.to_string())?;
            let origin = parent.inner_position().map_err(|e| e.to_string())?;
            let size = parent.inner_size().map_err(|e| e.to_string())?;
            let x = (origin.x as f64 + (size.width as f64 - width) / 2.0).clamp(
                area.position.x as f64,
                area.position.x as f64 + area.size.width as f64 - width,
            );
            let y = (origin.y as f64 + (size.height as f64 - height) / 2.0).clamp(
                area.position.y as f64,
                area.position.y as f64 + area.size.height as f64 - height - 32.0 * scale,
            );
            window
                .set_position(tauri::PhysicalPosition::new(x as i32, y as i32))
                .map_err(|e| e.to_string())?;
            parent.set_enabled(false).map_err(|e| e.to_string())?;
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    if result.is_err() {
        state.finish(&app, window.label(), false);
    } else if let Some(entry) = state.pending.lock().unwrap().get_mut(window.label()) {
        entry.ready = true;
    }
    result
}

#[tauri::command]
pub fn confirmation_answer(
    app: tauri::AppHandle,
    window: WebviewWindow,
    accepted: bool,
) -> Result<(), String> {
    let state = app.state::<Confirmations>();
    if !state
        .pending
        .lock()
        .unwrap()
        .get(window.label())
        .is_some_and(|p| p.ready)
    {
        return Err("Unknown or uninitialized confirmation window".into());
    }
    if accepted && app.state::<crate::windows::Windows>().suppress {
        return Err("Hidden acceptance cannot approve confirmations".into());
    }
    state.finish(&app, window.label(), accepted);
    Ok(())
}

#[tauri::command]
pub fn confirmation_cancel(app: tauri::AppHandle, window: WebviewWindow) -> Result<(), String> {
    let state = app.state::<Confirmations>();
    state.slot(window.label())?;
    {
        let mut cancellations = state.cancellations.lock().unwrap();
        let generation = cancellations.entry(window.label().to_string()).or_default();
        *generation = generation.wrapping_add(1);
    }
    let labels: Vec<_> = state
        .pending
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, entry)| entry.parent.label() == window.label())
        .map(|(label, _)| label.clone())
        .collect();
    for label in labels {
        state.finish(&app, &label, false);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn confirmation_roles_and_callback_ownership_are_bounded() {
        let state = Confirmations::default();
        assert!(state.slot("other").is_err());
        let slot = state.slot("main").unwrap().clone();
        let pending = slot.clone().try_lock_owned().unwrap();
        let (sender, receiver) = oneshot::channel::<bool>();
        let callback = move || {
            let _pending = pending;
            let _ = sender.send(false);
        };
        drop(receiver);
        assert!(slot.try_lock().is_err());
        assert!(state.slot("settings").unwrap().try_lock().is_ok());
        callback();
        assert!(slot.try_lock().is_ok());
    }
    #[test]
    fn confirmation_text_is_bounded_and_buttons_unambiguous() {
        let mut options = Options {
            title: "Remove".into(),
            message: "Remove this task?".into(),
            confirm_label: "Remove".into(),
            cancel_label: "Cancel".into(),
            kind: Kind::Warning,
        };
        assert!(options.validate().is_ok());
        options.message = "x".repeat(8193);
        assert!(options.validate().is_err());
        options.message = "Remove this task?".into();
        options.cancel_label = options.confirm_label.clone();
        assert!(options.validate().is_err());
        options.cancel_label = "Cancel".into();
        options.title = "Bad\ncaption".into();
        assert!(options.validate().is_err());
        assert!(serde_json::from_str::<Kind>("\"unknown\"").is_err());
    }
}
