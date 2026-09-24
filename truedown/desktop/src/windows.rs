use serde::Deserialize;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Settings,
    Logs,
    About,
    NewTask,
    #[serde(skip)]
    TaskDetails,
}

pub struct Windows {
    pub suppress: bool,
    pub creation: tokio::sync::Mutex<()>,
    pub storage: crate::webview::Storage,
    pub task_details: std::sync::Mutex<TaskDetails>,
}

#[derive(Clone, Copy, Default, serde::Serialize)]
pub struct TaskDetails {
    id: u64,
    open: bool,
    revision: u64,
}

impl Kind {
    fn icon(self) -> tauri::Result<tauri::image::Image<'static>> {
        let bytes: &[u8] = match self {
            Self::Settings | Self::Logs | Self::About => {
                include_bytes!("../icons/window/settings.png")
            }
            Self::NewTask => include_bytes!("../icons/window/download.png"),
            Self::TaskDetails => include_bytes!("../icons/window/info.png"),
        };
        tauri::image::Image::from_bytes(bytes)
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Settings => "settings",
            Self::Logs | Self::About => "settings",
            Self::NewTask => "new-task",
            Self::TaskDetails => "task-details",
        }
    }
    fn title(self) -> &'static str {
        match self {
            Self::Settings => "设置",
            Self::Logs => "应用日志",
            Self::About => "关于 TrueDown",
            Self::NewTask => "新建下载",
            Self::TaskDetails => "任务详情",
        }
    }
    fn url(self) -> &'static str {
        match self {
            Self::Settings => "index.html?window=settings#settings/general",
            Self::Logs => "index.html?window=settings#settings/logs",
            Self::About => "index.html?window=settings#settings/about",
            Self::NewTask => "index.html?window=new-task",
            Self::TaskDetails => "index.html?window=task-details",
        }
    }
}

pub fn allowed(window: &str, method: &str, path: &str) -> bool {
    match window {
        "main" => match method {
            "GET" => [
                "/tasks",
                "/settings/file-groups",
                "/system/info",
                "/system/storage",
                "/settings/task-defaults",
            ]
            .contains(&path),
            "POST" => [
                "/tasks/batch",
                "/tasks/open-file",
                "/tasks/open-folder",
                "/tasks/clear-done",
                "/queue/pause",
                "/queue/resume",
                "/system/open-downloads",
                "/system/exit",
            ]
            .contains(&path),
            _ => false,
        },
        "settings" => match method {
            "GET" => [
                "/system/info",
                "/system/storage",
                "/system/logs",
                "/system/update",
                "/settings/runtime",
                "/settings/download-rules",
                "/settings/task-defaults",
                "/settings/file-groups",
                "/settings/tracker-research",
                "/settings/updates",
                "/settings/startup",
                "/modules",
                "/auth/settings",
            ]
            .contains(&path),
            "POST" => [
                "/settings/runtime",
                "/settings/download-rules",
                "/settings/task-defaults",
                "/settings/file-groups",
                "/settings/tracker-research",
                "/settings/updates",
                "/settings/startup",
                "/modules",
                "/modules/package",
                "/auth/settings",
                "/system/open-downloads",
                "/system/engine/next",
                "/system/engine/select",
                "/system/update/check",
                "/system/update/restart",
            ]
            .contains(&path),
            "DELETE" => path == "/modules/package",
            _ => false,
        },
        "task-details" => match method {
            "GET" => path == "/tasks/detail",
            "POST" => [
                "/tasks/detail",
                "/tasks/batch",
                "/tasks/open-file",
                "/tasks/open-folder",
            ]
            .contains(&path),
            _ => false,
        },
        "new-task" => match method {
            "GET" => [
                "/settings/task-defaults",
                "/settings/download-rules",
                "/modules",
            ]
            .contains(&path),
            "POST" => ["/start-headless-download", "/start-bt-download"].contains(&path),
            _ => false,
        },
        _ => false,
    }
}

pub fn minimum_size(label: &str) -> (f64, f64) {
    match label {
        "settings" => (640.0, 480.0),
        "new-task" => (520.0, 420.0),
        "task-details" => (520.0, 420.0),
        _ => (620.0, 480.0),
    }
}

#[tauri::command]
pub async fn open_auxiliary(app: tauri::AppHandle, kind: Kind) -> Result<(), String> {
    let state = app.state::<Windows>();
    let _creation = state.creation.lock().await;
    open_auxiliary_locked(&app, &state, kind, None).await
}

fn group_settings_route(role: &str, group_id: Option<&str>, add: bool) -> Result<String, String> {
    if role != "main" || (add && group_id.is_some()) {
        return Err("Open group settings from the main window".into());
    }
    if let Some(id) = group_id {
        if id.is_empty()
            || id.len() > 64
            || !id.as_bytes()[0].is_ascii_lowercase()
            || !id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err("Invalid file group ID".into());
        }
        return Ok(format!("settings/files/group/{id}"));
    }
    Ok(if add {
        "settings/files/add-group"
    } else {
        "settings/files"
    }
    .into())
}

#[tauri::command]
pub async fn open_group_settings(
    app: tauri::AppHandle,
    window: WebviewWindow,
    group_id: Option<String>,
    add: bool,
) -> Result<(), String> {
    let route = group_settings_route(window.label(), group_id.as_deref(), add)?;
    let state = app.state::<Windows>();
    let _creation = state.creation.lock().await;
    open_auxiliary_locked(&app, &state, Kind::Settings, Some(&route)).await
}

async fn open_auxiliary_locked(
    app: &tauri::AppHandle,
    state: &Windows,
    kind: Kind,
    settings_route: Option<&str>,
) -> Result<(), String> {
    let existing = app.get_webview_window(kind.label());
    let reused = existing.is_some();
    let window = if let Some(window) = existing {
        window
    } else {
        let (width, height) = match kind {
            Kind::Settings | Kind::Logs | Kind::About => (960.0, 760.0),
            Kind::NewTask => (660.0, 560.0),
            Kind::TaskDetails => (780.0, 640.0),
        };
        let (min_width, min_height) = minimum_size(kind.label());
        let window = crate::frame::configure(
            state.storage.configure(WebviewWindowBuilder::new(
                app,
                kind.label(),
                WebviewUrl::App(
                    settings_route
                        .map(|route| format!("index.html?window=settings#{route}"))
                        .unwrap_or_else(|| kind.url().into())
                        .into(),
                ),
            )),
        )
        .title(kind.title())
        .icon(kind.icon().map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?
        .inner_size(width, height)
        .min_inner_size(min_width, min_height)
        .visible(false)
        .transparent(cfg!(any(windows, target_os = "macos")))
        .center()
        .on_navigation(local_navigation)
        .build()
        .map_err(|error| error.to_string())?;
        crate::frame::install_async(&window).await?;
        crate::placement::fit(&window.as_ref().window(), true);
        window
    };
    if let Some(route) = settings_route {
        // A new window receives the intent in its initial URL exactly once.
        if reused {
            let hash =
                serde_json::to_string(&format!("#{route}")).map_err(|error| error.to_string())?;
            window.eval(&format!("if (location.hash === {hash}) {{ window.focusFileGroupRoute?.(); }} else {{ location.hash = {hash}; }}"))
                .map_err(|error| error.to_string())?;
        }
    } else if matches!(kind, Kind::Settings | Kind::Logs | Kind::About) {
        let page = match kind {
            Kind::Logs => "logs",
            Kind::About => "about",
            _ => "general",
        };
        window
            .emit("truedown:settings-page", page)
            .map_err(|error| error.to_string())?;
    }
    if !state.suppress {
        crate::placement::fit(&window.as_ref().window(), false);
        window
            .show()
            .and_then(|_| window.unminimize())
            .and_then(|_| window.set_focus())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn local_navigation(url: &tauri::Url) -> bool {
    matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
    ) && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

#[tauri::command]
pub fn close_auxiliary(window: WebviewWindow) -> Result<(), String> {
    if !["settings", "logs", "about", "new-task", "task-details"].contains(&window.label()) {
        return Err("This action closes auxiliary windows only".into());
    }
    // Hiding retains unsaved settings and keyboard position across reopen.
    window.hide().map_err(|error| error.to_string())?;
    task_details_hidden(window.app_handle(), window.label());
    Ok(())
}

fn validate_task_details_request(role: &str, id: u64) -> Result<(), String> {
    if role != "main" || id == 0 || id > 9_007_199_254_740_991 {
        return Err("Open task details from the task list with a valid task ID".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn open_task_details(
    app: tauri::AppHandle,
    window: WebviewWindow,
    id: u64,
) -> Result<(), String> {
    validate_task_details_request(window.label(), id)?;
    let state = app.state::<Windows>();
    let _creation = state.creation.lock().await;
    {
        let mut details = state.task_details.lock().unwrap();
        details.id = id;
        details.open = true;
        details.revision += 1;
    }
    open_auxiliary_locked(&app, &state, Kind::TaskDetails, None).await?;
    emit_task_details(&app)
}

#[tauri::command]
pub fn task_details_state(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<TaskDetails, String> {
    if window.label() != "task-details" {
        return Err("Task details state is available only in its own window".into());
    }
    Ok(*app.state::<Windows>().task_details.lock().unwrap())
}

fn emit_task_details(app: &tauri::AppHandle) -> Result<(), String> {
    let details = *app.state::<Windows>().task_details.lock().unwrap();
    app.emit_to("task-details", "truedown:task-details", details)
        .map_err(|error| error.to_string())
}

pub fn task_details_hidden(app: &tauri::AppHandle, label: &str) {
    if label != "task-details" {
        return;
    }
    {
        let state = app.state::<Windows>();
        let mut details = state.task_details.lock().unwrap();
        details.open = false;
        details.revision += 1;
    }
    let _ = emit_task_details(app);
}

#[tauri::command]
pub fn finish_task_window(app: tauri::AppHandle, window: WebviewWindow) -> Result<(), String> {
    if window.label() != "new-task" {
        return Err("Only a task form can finish this action".into());
    }
    window.hide().map_err(|error| error.to_string())?;
    crate::show_main(&app);
    if let Some(main) = app.get_webview_window("main") {
        main.emit("truedown:tasks-created", ())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn auxiliary_icons_are_distinct_from_the_brand_and_each_other() {
        let settings = Kind::Settings.icon().unwrap();
        assert_eq!((settings.width(), settings.height()), (256, 256));
        assert_eq!(settings.rgba(), Kind::About.icon().unwrap().rgba());
        assert_eq!(settings.rgba(), Kind::Logs.icon().unwrap().rgba());
        assert_ne!(settings.rgba(), Kind::NewTask.icon().unwrap().rgba());
        assert_ne!(settings.rgba(), Kind::TaskDetails.icon().unwrap().rgba());
    }
    #[test]
    fn windows_have_only_their_own_operations() {
        assert!(!allowed("about", "POST", "/settings/runtime"));
        assert!(!allowed("logs", "GET", "/auth/token"));
        assert!(!allowed("settings", "POST", "/system/exit"));
        assert!(allowed("settings", "POST", "/settings/runtime"));
        assert!(!allowed("about", "GET", "/system/info"));
        for window in ["main", "settings", "new-task", "task-details"] {
            assert!(!allowed(window, "GET", "/auth/token"));
            assert!(!allowed(
                window,
                "POST",
                "/settings/future-privileged-operation"
            ));
        }
        assert!(!allowed("main", "POST", "/auth/settings"));
        assert!(!allowed("main", "POST", "/settings/startup"));
        assert!(!allowed("main", "POST", "/tasks/detail"));
        assert!(allowed("task-details", "GET", "/tasks/detail"));
        assert!(allowed("task-details", "POST", "/tasks/detail"));
        assert!(allowed("task-details", "POST", "/tasks/batch"));
        for path in [
            "/tasks",
            "/settings/task-defaults",
            "/auth/settings",
            "/system/exit",
        ] {
            assert!(!allowed("task-details", "GET", path));
            assert!(!allowed("task-details", "POST", path));
        }
        assert!(!allowed("batch-task", "POST", "/start-headless-download"));
        let window = "new-task";
        assert!(allowed(window, "GET", "/settings/task-defaults"));
        assert!(allowed(window, "POST", "/start-headless-download"));
        assert!(allowed(window, "POST", "/start-bt-download"));
        assert!(!allowed(window, "POST", "/settings/task-defaults"));
        assert!(!allowed(window, "POST", "/system/exit"));
        assert!(!allowed(window, "GET", "/tasks"));
        assert!(!allowed(window, "GET", "/auth/token"));
    }

    #[test]
    fn group_settings_targets_are_bounded_and_main_only() {
        assert_eq!(
            group_settings_route("main", Some("group-123"), false).unwrap(),
            "settings/files/group/group-123"
        );
        assert_eq!(
            group_settings_route("main", None, true).unwrap(),
            "settings/files/add-group"
        );
        assert_eq!(
            group_settings_route("main", None, false).unwrap(),
            "settings/files"
        );
        for role in [
            "settings",
            "new-task",
            "task-details",
            "context-menu-main-0",
        ] {
            assert!(group_settings_route(role, Some("image"), false).is_err());
        }
        for id in [
            "",
            "../image",
            "image/other",
            "Image",
            "1group",
            "a\";alert(1)",
            &"a".repeat(65),
        ] {
            assert!(group_settings_route("main", Some(id), false).is_err());
        }
        assert!(group_settings_route("main", Some("image"), true).is_err());
    }

    #[test]
    fn task_details_requests_are_bounded_and_main_only() {
        assert!(validate_task_details_request("main", 1).is_ok());
        for (role, id) in [
            ("main", 0),
            ("main", 9_007_199_254_740_992),
            ("settings", 1),
            ("task-details", 1),
        ] {
            assert!(validate_task_details_request(role, id).is_err());
        }
        assert!(serde_json::from_str::<Kind>("\"batch-task\"").is_err());
        assert!(serde_json::from_str::<Kind>("\"task-details\"").is_err());
    }
}
