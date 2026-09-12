use std::sync::Arc;
use tauri::{Manager, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio::sync::{oneshot, Mutex};

#[derive(Default)]
pub struct Confirmations {
    slots: [Arc<Mutex<()>>; 4],
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    title: String,
    message: String,
    confirm_label: String,
    cancel_label: String,
    danger: bool,
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
        Ok(())
    }
}

impl Confirmations {
    fn slot(&self, role: &str) -> Result<&Arc<Mutex<()>>, String> {
        let index = match role {
            "main" => 0,
            "settings" => 1,
            "new-task" => 2,
            "batch-task" => 3,
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
        let pending = self
            .slot(window.label())?
            .clone()
            .try_lock_owned()
            .map_err(|_| "A confirmation is already open for this window")?;
        if app.state::<crate::windows::Windows>().suppress {
            return Err("Native dialogs are suppressed during hidden acceptance".into());
        }
        let (sender, receiver) = oneshot::channel();
        app.dialog()
            .message(options.message)
            .title(options.title)
            .parent(&window)
            .kind(if options.danger {
                MessageDialogKind::Warning
            } else {
                MessageDialogKind::Info
            })
            .buttons(MessageDialogButtons::OkCancelCustom(
                options.confirm_label,
                options.cancel_label,
            ))
            .show(move |accepted| {
                let _pending = pending;
                let _ = sender.send(accepted);
            });
        // The OS callback owns the slot even if the originating IPC is cancelled.
        receiver
            .await
            .map_err(|_| "Confirmation closed without a result".into())
    }
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
            danger: true,
        };
        assert!(options.validate().is_ok());
        options.message = "x".repeat(8193);
        assert!(options.validate().is_err());
        options.message = "Remove this task?".into();
        options.cancel_label = options.confirm_label.clone();
        assert!(options.validate().is_err());
    }
}
