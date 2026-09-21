use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconEvent},
    Manager,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Main,
    NewTask,
    Settings,
    None,
    Menu,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Platform {
    Windows,
    Macos,
    Linux,
}

impl Platform {
    fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else {
            Self::Linux
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    single_click: Action,
    double_click: Action,
}

impl Preferences {
    fn defaults(platform: Platform) -> Self {
        match platform {
            Platform::Windows => Self {
                single_click: Action::Main,
                double_click: Action::NewTask,
            },
            _ => Self {
                single_click: Action::Menu,
                double_click: Action::None,
            },
        }
    }

    fn validate(self, platform: Platform) -> Result<Self, String> {
        if platform == Platform::Linux
            || self.double_click == Action::Menu
            || (platform == Platform::Windows && self.single_click == Action::Menu)
            || (platform == Platform::Macos && self.double_click != Action::None)
        {
            return Err("Unsupported tray action for this platform".into());
        }
        Ok(self)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stored {
    windows: Preferences,
    macos: Preferences,
}

impl Default for Stored {
    fn default() -> Self {
        Self {
            windows: Preferences::defaults(Platform::Windows),
            macos: Preferences::defaults(Platform::Macos),
        }
    }
}

impl Stored {
    fn get(&self, platform: Platform) -> Preferences {
        match platform {
            Platform::Windows => self.windows,
            Platform::Macos => self.macos,
            Platform::Linux => Preferences::defaults(platform),
        }
    }
    fn set(&mut self, platform: Platform, value: Preferences) {
        match platform {
            Platform::Windows => self.windows = value,
            Platform::Macos => self.macos = value,
            Platform::Linux => {}
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    single_supported: bool,
    double_supported: bool,
    #[serde(flatten)]
    preferences: Preferences,
}

struct Inner {
    stored: Stored,
    generation: u64,
    pending: Option<u64>,
}
pub struct TraySettings {
    path: PathBuf,
    platform: Platform,
    inner: Mutex<Inner>,
}

impl TraySettings {
    pub fn load(path: PathBuf) -> Result<Self, String> {
        let stored = match std::fs::File::open(&path) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(4097)
                    .read_to_end(&mut bytes)
                    .map_err(|e| e.to_string())?;
                if bytes.len() > 4096 {
                    return Err("Tray settings exceed 4 KiB".into());
                }
                let value: Stored = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                value.windows.validate(Platform::Windows)?;
                value.macos.validate(Platform::Macos)?;
                value
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Stored::default(),
            Err(error) => return Err(error.to_string()),
        };
        Ok(Self {
            path,
            platform: Platform::current(),
            inner: Mutex::new(Inner {
                stored,
                generation: 0,
                pending: None,
            }),
        })
    }

    pub fn menu_on_left_click(&self) -> bool {
        self.inner
            .lock()
            .unwrap()
            .stored
            .get(self.platform)
            .single_click
            == Action::Menu
    }

    pub fn update(
        &self,
        app: &tauri::AppHandle,
        value: Option<Preferences>,
    ) -> Result<Snapshot, String> {
        let mut inner = self.inner.lock().unwrap();
        if let Some(value) = value {
            let value = value.validate(self.platform)?;
            let previous = inner.stored.get(self.platform);
            let tray = app.tray_by_id("main-tray").ok_or("Tray is unavailable")?;
            tray.set_show_menu_on_left_click(value.single_click == Action::Menu)
                .map_err(|e| e.to_string())?;
            inner.stored.set(self.platform, value);
            if let Err(error) = self.persist(&inner.stored) {
                inner.stored.set(self.platform, previous);
                let _ = tray.set_show_menu_on_left_click(previous.single_click == Action::Menu);
                return Err(error);
            }
            inner.pending = None;
            inner.generation = inner.generation.wrapping_add(1);
        }
        Ok(Snapshot {
            single_supported: self.platform != Platform::Linux,
            double_supported: self.platform == Platform::Windows,
            preferences: inner.stored.get(self.platform),
        })
    }

    fn persist(&self, stored: &Stored) -> Result<(), String> {
        let directory = self
            .path
            .parent()
            .ok_or("Missing tray settings directory")?;
        let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
        let bytes = serde_json::to_vec(stored).map_err(|e| e.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.as_file().sync_all())
            .map_err(|e| e.to_string())?;
        file.persist(&self.path).map_err(|e| e.to_string())?;
        Ok(())
    }
}

// Windows delivers Down, Up, DoubleClick, Up. Defer the first Down by the OS
// double-click interval; the DoubleClick cancels it. Releases never steal focus.
#[derive(Debug, PartialEq)]
enum Dispatch {
    Ignore,
    Now(Action),
    Later(u64),
}

fn dispatch(inner: &mut Inner, platform: Platform, event: &TrayIconEvent) -> Dispatch {
    let value = inner.stored.get(platform);
    match event {
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Down,
            ..
        } if platform == Platform::Windows => {
            inner.generation = inner.generation.wrapping_add(1);
            inner.pending = Some(inner.generation);
            Dispatch::Later(inner.generation)
        }
        TrayIconEvent::DoubleClick {
            button: MouseButton::Left,
            ..
        } if platform == Platform::Windows => {
            inner.pending = None;
            Dispatch::Now(value.double_click)
        }
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } if platform == Platform::Macos => Dispatch::Now(value.single_click),
        _ => Dispatch::Ignore,
    }
}

fn finish_single(inner: &mut Inner, token: u64, platform: Platform) -> Option<Action> {
    if inner.pending != Some(token) {
        return None;
    }
    inner.pending = None;
    Some(inner.stored.get(platform).single_click)
}

fn perform(app: &tauri::AppHandle, action: Action) {
    match action {
        Action::Main => crate::show_main(app),
        Action::NewTask | Action::Settings => {
            let app = app.clone();
            let kind = if action == Action::NewTask {
                crate::windows::Kind::NewTask
            } else {
                crate::windows::Kind::Settings
            };
            tauri::async_runtime::spawn(async move {
                if let Err(error) = crate::windows::open_auxiliary(app, kind).await {
                    eprintln!("Cannot perform tray action: {error}");
                }
            });
        }
        Action::None | Action::Menu => {}
    }
}

pub fn handle(app: &tauri::AppHandle, event: TrayIconEvent) {
    let state = app.state::<Arc<TraySettings>>();
    let result = dispatch(&mut state.inner.lock().unwrap(), state.platform, &event);
    match result {
        Dispatch::Now(action) => perform(app, action),
        Dispatch::Later(token) => {
            #[cfg(windows)]
            let delay =
                unsafe { windows_sys::Win32::UI::Input::KeyboardAndMouse::GetDoubleClickTime() };
            #[cfg(not(windows))]
            let delay = 500u32;
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(u64::from(delay))).await;
                let target = app.clone();
                let _ = app.run_on_main_thread(move || {
                    let state = target.state::<Arc<TraySettings>>();
                    let action =
                        finish_single(&mut state.inner.lock().unwrap(), token, state.platform);
                    if let Some(action) = action {
                        perform(&target, action);
                    }
                });
            });
        }
        Dispatch::Ignore => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn inner() -> Inner {
        Inner {
            stored: Stored::default(),
            generation: 0,
            pending: None,
        }
    }
    fn click(button: MouseButton, button_state: MouseButtonState) -> TrayIconEvent {
        TrayIconEvent::Click {
            id: "test".into(),
            position: tauri::PhysicalPosition::new(0.0, 0.0),
            rect: tauri::Rect::default(),
            button,
            button_state,
        }
    }
    #[test]
    fn windows_double_click_cancels_single_and_ignores_final_release() {
        let mut inner = inner();
        assert_eq!(
            dispatch(
                &mut inner,
                Platform::Windows,
                &click(MouseButton::Left, MouseButtonState::Down)
            ),
            Dispatch::Later(1)
        );
        assert_eq!(
            dispatch(
                &mut inner,
                Platform::Windows,
                &click(MouseButton::Left, MouseButtonState::Up)
            ),
            Dispatch::Ignore
        );
        let double = TrayIconEvent::DoubleClick {
            id: "test".into(),
            position: tauri::PhysicalPosition::new(0.0, 0.0),
            rect: tauri::Rect::default(),
            button: MouseButton::Left,
        };
        assert_eq!(
            dispatch(&mut inner, Platform::Windows, &double),
            Dispatch::Now(Action::NewTask)
        );
        assert_eq!(finish_single(&mut inner, 1, Platform::Windows), None);
        assert_eq!(
            dispatch(
                &mut inner,
                Platform::Windows,
                &click(MouseButton::Left, MouseButtonState::Up)
            ),
            Dispatch::Ignore
        );
    }
    #[test]
    fn single_click_and_platform_capabilities() {
        let mut inner = inner();
        inner.stored.windows.single_click = Action::Settings;
        dispatch(
            &mut inner,
            Platform::Windows,
            &click(MouseButton::Left, MouseButtonState::Down),
        );
        assert_eq!(
            finish_single(&mut inner, 1, Platform::Windows),
            Some(Action::Settings)
        );
        assert_eq!(finish_single(&mut inner, 1, Platform::Windows), None);
        inner.stored.macos.single_click = Action::NewTask;
        assert_eq!(
            dispatch(
                &mut inner,
                Platform::Macos,
                &click(MouseButton::Left, MouseButtonState::Down)
            ),
            Dispatch::Ignore
        );
        assert_eq!(
            dispatch(
                &mut inner,
                Platform::Macos,
                &click(MouseButton::Left, MouseButtonState::Up)
            ),
            Dispatch::Now(Action::NewTask)
        );
        for platform in [Platform::Windows, Platform::Macos, Platform::Linux] {
            assert_eq!(
                dispatch(
                    &mut inner,
                    platform,
                    &click(MouseButton::Right, MouseButtonState::Up)
                ),
                Dispatch::Ignore
            );
        }
        assert_eq!(
            dispatch(
                &mut inner,
                Platform::Linux,
                &click(MouseButton::Left, MouseButtonState::Up)
            ),
            Dispatch::Ignore
        );
        assert!(Preferences::defaults(Platform::Windows)
            .validate(Platform::Macos)
            .is_err());
        assert!(Preferences::defaults(Platform::Macos)
            .validate(Platform::Windows)
            .is_err());
        assert!(Preferences::defaults(Platform::Linux)
            .validate(Platform::Linux)
            .is_err());
    }
    #[test]
    fn persistence_is_bounded_and_keeps_platforms_independent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tray.json");
        let state = TraySettings::load(path.clone()).unwrap();
        let mut stored = Stored::default();
        stored.windows.single_click = Action::None;
        state.persist(&stored).unwrap();
        let loaded = TraySettings::load(path.clone()).unwrap();
        assert_eq!(
            loaded.inner.lock().unwrap().stored.windows.single_click,
            Action::None
        );
        assert_eq!(
            loaded.inner.lock().unwrap().stored.macos.single_click,
            Action::Menu
        );
        std::fs::write(&path, vec![b' '; 4097]).unwrap();
        assert!(TraySettings::load(path.clone()).is_err());
        std::fs::write(&path, b"{}").unwrap();
        assert!(TraySettings::load(path).is_err());
        assert!(serde_json::from_str::<Preferences>(
            r#"{"singleClick":"exit","doubleClick":"none"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<Preferences>(r#"{"singleClick":"main"}"#).is_err());
    }
}
