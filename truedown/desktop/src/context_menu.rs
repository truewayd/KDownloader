//! Prebuilt OS popup menus. WebViews supply context, never menu definitions.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    Emitter, Manager,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Edit,
    EditSelection,
    Password,
    ReadOnly,
    Selection,
    Task,
    Workspace,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Action {
    Details,
    Pause,
    Resume,
    Requeue,
    OpenFile,
    OpenFolder,
    Remove,
    NewTask,
    BatchTask,
    Settings,
}

impl Action {
    fn id(self) -> &'static str {
        match self {
            Self::Details => "details",
            Self::Pause => "pause",
            Self::Resume => "resume",
            Self::Requeue => "requeue",
            Self::OpenFile => "open-file",
            Self::OpenFolder => "open-folder",
            Self::Remove => "remove",
            Self::NewTask => "new-task",
            Self::BatchTask => "batch-task",
            Self::Settings => "settings",
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    kind: Kind,
    token: String,
    actions: Vec<Action>,
    x: f64,
    y: f64,
}

impl Request {
    fn validate(&self, role: &str) -> Result<(), String> {
        if !["main", "settings", "new-task", "batch-task"].contains(&role)
            || self.token.is_empty()
            || self.token.len() > 80
            || !self
                .token
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
            || !self.x.is_finite()
            || !self.y.is_finite()
            || !(0.0..=32768.0).contains(&self.x)
            || !(0.0..=32768.0).contains(&self.y)
            || self.actions.len() > 10
        {
            return Err("Invalid context menu request".into());
        }
        let allowed: &[Action] = match self.kind {
            Kind::Task if role == "main" => &[
                Action::Details,
                Action::Pause,
                Action::Resume,
                Action::Requeue,
                Action::OpenFile,
                Action::OpenFolder,
                Action::Remove,
            ],
            Kind::Workspace if role == "main" => {
                &[Action::NewTask, Action::BatchTask, Action::Settings]
            }
            Kind::Task | Kind::Workspace => return Err("Menu unavailable in this window".into()),
            _ => &[],
        };
        if self.actions.iter().any(|action| !allowed.contains(action)) {
            return Err("Invalid context menu action".into());
        }
        Ok(())
    }
}

#[derive(Clone, serde::Serialize)]
struct Selection {
    token: String,
    action: Action,
}
struct Pending {
    role: String,
    token: String,
    actions: Vec<Action>,
}
pub struct Menus {
    menus: HashMap<Kind, Menu<tauri::Wry>>,
    items: Vec<(Action, MenuItem<tauri::Wry>)>,
    pending: Mutex<Option<Pending>>,
    opening: Arc<tokio::sync::Mutex<()>>,
}

pub fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
    let mut menus = HashMap::new();
    for kind in [
        Kind::Edit,
        Kind::EditSelection,
        Kind::Password,
        Kind::ReadOnly,
        Kind::Selection,
    ] {
        let menu = Menu::new(app)?;
        if cfg!(target_os = "macos")
            && matches!(kind, Kind::Edit | Kind::EditSelection | Kind::Password)
        {
            menu.append(&PredefinedMenuItem::undo(app, Some("\u{64a4}\u{9500}"))?)?;
            menu.append(&PredefinedMenuItem::redo(app, Some("\u{91cd}\u{505a}"))?)?;
            menu.append(&PredefinedMenuItem::separator(app)?)?;
        }
        if kind == Kind::EditSelection {
            menu.append(&PredefinedMenuItem::cut(app, Some("\u{526a}\u{5207}"))?)?;
        }
        if matches!(kind, Kind::EditSelection | Kind::ReadOnly | Kind::Selection) {
            menu.append(&PredefinedMenuItem::copy(app, Some("\u{590d}\u{5236}"))?)?;
        }
        if matches!(kind, Kind::Edit | Kind::EditSelection | Kind::Password) {
            menu.append(&PredefinedMenuItem::paste(app, Some("\u{7c98}\u{8d34}"))?)?;
        }
        menu.append(&PredefinedMenuItem::select_all(
            app,
            Some("\u{5168}\u{9009}"),
        )?)?;
        menus.insert(kind, menu);
    }
    let task = Menu::new(app)?;
    let workspace = Menu::new(app)?;
    let mut items = Vec::new();
    for (action, label) in [
        (Action::Details, "\u{4efb}\u{52a1}\u{8be6}\u{60c5}"),
        (Action::Pause, "\u{6682}\u{505c}"),
        (Action::Resume, "\u{7ee7}\u{7eed}"),
        (Action::Requeue, "\u{91cd}\u{8bd5}"),
        (Action::OpenFile, "\u{6253}\u{5f00}\u{6587}\u{4ef6}"),
        (
            Action::OpenFolder,
            "\u{6253}\u{5f00}\u{4e0b}\u{8f7d}\u{76ee}\u{5f55}",
        ),
        (Action::Remove, "\u{79fb}\u{9664}\u{4efb}\u{52a1}"),
        (Action::NewTask, "\u{65b0}\u{5efa}\u{4e0b}\u{8f7d}\u{2026}"),
        (
            Action::BatchTask,
            "\u{6279}\u{91cf}\u{4e0b}\u{8f7d}\u{2026}",
        ),
        (Action::Settings, "\u{8bbe}\u{7f6e}\u{2026}"),
    ] {
        let menu = if matches!(
            action,
            Action::NewTask | Action::BatchTask | Action::Settings
        ) {
            &workspace
        } else {
            &task
        };
        if matches!(
            action,
            Action::Pause | Action::OpenFile | Action::Remove | Action::Settings
        ) {
            menu.append(&PredefinedMenuItem::separator(app)?)?;
        }
        let item = MenuItem::with_id(
            app,
            format!("context-{}", action.id()),
            label,
            true,
            None::<&str>,
        )?;
        menu.append(&item)?;
        items.push((action, item));
    }
    menus.insert(Kind::Task, task);
    menus.insert(Kind::Workspace, workspace);
    app.manage(Menus {
        menus,
        items,
        pending: Mutex::new(None),
        opening: Arc::new(tokio::sync::Mutex::new(())),
    });
    app.on_menu_event(|app, event| {
        let state = app.state::<Menus>();
        let Some((action, _)) = state
            .items
            .iter()
            .find(|(action, _)| event.id.as_ref() == format!("context-{}", action.id()))
        else {
            return;
        };
        let pending = state.pending.lock().unwrap().take();
        if let Some(pending) = pending.filter(|pending| pending.actions.contains(action)) {
            let _ = app.emit_to(
                &pending.role,
                "truedown:context-action",
                Selection {
                    token: pending.token,
                    action: *action,
                },
            );
        }
    });
    Ok(())
}

pub async fn show(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: Request,
) -> Result<(), String> {
    request.validate(window.label())?;
    if app.state::<crate::windows::Windows>().suppress {
        return Err("Native menus are suppressed during hidden acceptance".into());
    }
    // Ownership travels into the UI callback, even if the IPC caller disappears.
    let slot = app
        .state::<Menus>()
        .opening
        .clone()
        .try_lock_owned()
        .map_err(|_| "A context menu is already opening")?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _slot = slot;
        let result = (|| -> tauri::Result<()> {
            if !window.is_visible()? || !window.is_focused()? {
                return Ok(());
            }
            let state = handle.state::<Menus>();
            for (action, item) in &state.items {
                item.set_enabled(request.actions.contains(action))?;
            }
            *state.pending.lock().unwrap() = Some(Pending {
                role: window.label().to_string(),
                token: request.token,
                actions: request.actions,
            });
            let size = window
                .inner_size()?
                .to_logical::<f64>(window.scale_factor()?);
            window.popup_menu_at(
                &state.menus[&request.kind],
                tauri::LogicalPosition::new(
                    request.x.min(size.width.max(1.0) - 1.0),
                    request.y.min(size.height.max(1.0) - 1.0),
                ),
            )
        })();
        let _ = sender.send(result.map_err(|error| error.to_string()));
    })
    .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "Context menu closed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requests_are_bounded_and_role_scoped() {
        let mut request = Request {
            kind: Kind::Task,
            token: "request-1".into(),
            actions: vec![Action::Pause],
            x: 12.0,
            y: 20.0,
        };
        assert!(request.validate("main").is_ok());
        for role in ["settings", "new-task", "batch-task", "unknown"] {
            assert!(request.validate(role).is_err());
        }
        request.actions.push(Action::Settings);
        assert!(request.validate("main").is_err());
        request.actions.clear();
        request.kind = Kind::Edit;
        assert!(request.validate("settings").is_ok());
        request.x = f64::NAN;
        assert!(request.validate("settings").is_err());
        request.x = 0.0;
        request.token = "x".repeat(81);
        assert!(request.validate("settings").is_err());
    }
}
