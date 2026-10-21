use crate::{bridge::Request, core::Core, windows::Windows};
use serde::Deserialize;
use std::{
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};
use tauri::Manager;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NotificationKind {
    Error,
    Warning,
}

impl NotificationKind {
    fn name(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warning => "warning",
        }
    }
    fn bytes(self) -> &'static [u8] {
        match self {
            Self::Error => include_bytes!("../icons/notifications/error.png"),
            Self::Warning => include_bytes!("../icons/notifications/warning.png"),
        }
    }
}

struct NotificationIcons {
    brand: Option<PathBuf>,
    error: Option<PathBuf>,
    warning: Option<PathBuf>,
}

impl NotificationIcons {
    fn get(&self, kind: NotificationKind) -> Option<&Path> {
        match kind {
            NotificationKind::Error => self.error.as_deref(),
            NotificationKind::Warning => self.warning.as_deref(),
        }
        .or(self.brand.as_deref())
    }
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Issues {
    epoch: String,
    downloads: u64,
    dropbox: u64,
    google_drive: u64,
    #[serde(default)]
    engine_required: u64,
}

impl Issues {
    fn counts(&self) -> [u64; 4] {
        [
            self.downloads,
            self.dropbox,
            self.google_drive,
            self.engine_required,
        ]
    }
}

#[derive(Default)]
struct Aggregate {
    previous: Option<Issues>,
    counts: [u64; 4],
    changed: Option<Instant>,
    delivered: Option<Instant>,
    attempted: Option<Instant>,
    dirty: bool,
}

impl Aggregate {
    fn kind(&self) -> NotificationKind {
        if self.counts[..3].iter().any(|count| *count > 0) {
            NotificationKind::Error
        } else {
            NotificationKind::Warning
        }
    }

    fn observe(&mut self, snapshot: Issues, now: Instant) {
        let Some(previous) = self.previous.replace(snapshot.clone()) else {
            return;
        };
        if previous.epoch != snapshot.epoch {
            self.counts = [0; 4];
            self.delivered = None;
            self.attempted = None;
            self.changed = None;
            self.dirty = false;
            return;
        }
        let delta = std::array::from_fn::<_, 4, _>(|i| {
            snapshot.counts()[i].saturating_sub(previous.counts()[i])
        });
        if delta == [0; 4] {
            return;
        }
        if self
            .changed
            .is_some_and(|at| now.duration_since(at) >= Duration::from_secs(120))
        {
            self.counts = [0; 4];
            self.delivered = None;
            self.attempted = None;
        }
        for (count, added) in self.counts.iter_mut().zip(delta) {
            *count = count.saturating_add(added);
        }
        self.changed = Some(now);
        self.dirty = true;
    }

    fn message(&self, now: Instant) -> Option<(String, bool)> {
        if !self.dirty
            || self
                .attempted
                .is_some_and(|at| now.duration_since(at) < Duration::from_secs(30))
        {
            return None;
        }
        let [ordinary, dropbox, drive, engine] = self.counts;
        let mut body = String::new();
        if ordinary > 0 || dropbox > 0 || drive > 0 {
            body = format!("下载问题：{ordinary}；Dropbox 模块或下载问题：{dropbox}；Google Drive 模块或下载问题：{drive}。请在任务列表或模块设置中查看。");
        }
        if engine > 0 {
            body.push_str(&format!("{engine} 个媒体任务已保存，等待兼容引擎。请在设置中启用 NEXT 3；原本暂停的任务将保持暂停。"));
        }
        Some((body, self.delivered.is_some()))
    }

    fn delivery_result(&mut self, now: Instant, accepted: bool) {
        self.attempted = Some(now);
        if accepted {
            self.delivered = Some(now);
            self.dirty = false;
        }
    }
}

struct Delivery {
    body: String,
    update: bool,
    kind: NotificationKind,
    result: tokio::sync::oneshot::Sender<bool>,
}

// A bounded family of small, stable assets in the profile cache.
fn prepare_icon(cache: &Path, kind: Option<NotificationKind>) -> Result<PathBuf, String> {
    use std::io::Write;
    let directory = cache.join("notifications");
    std::fs::create_dir_all(cache).map_err(|error| error.to_string())?;
    match std::fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.is_dir() && !is_alias(&metadata) => {}
        Ok(_) => return Err("Unsafe notification icon directory".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(&directory).map_err(|error| error.to_string())?;
        }
        Err(error) => return Err(error.to_string()),
    }
    let name = kind
        .map(|kind| format!("truedown-{}.png", kind.name()))
        .unwrap_or_else(|| "truedown.png".into());
    let path = directory.join(name);
    let bytes = kind
        .map(NotificationKind::bytes)
        .unwrap_or(include_bytes!("../icons/notification.png"));
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if !metadata.is_file() || is_alias(&metadata) {
                return Err("Unsafe notification icon file".into());
            }
            if metadata.len() == bytes.len() as u64
                && std::fs::read(&path).is_ok_and(|current| current == bytes)
            {
                return Ok(path);
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    let mut temporary = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    temporary.write_all(bytes).map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    temporary.persist(&path).map_err(|e| e.to_string())?;
    Ok(path)
}

fn is_alias(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}

pub fn start(app: &tauri::AppHandle, core: Arc<Core>, cache: PathBuf) {
    if app.state::<Windows>().suppress {
        return;
    }
    let identifier = app.config().identifier.clone();
    let target = app.clone();
    let (sender, receiver) = std::sync::mpsc::sync_channel::<Delivery>(1);
    std::thread::spawn(move || {
        let prepare = |kind| {
            prepare_icon(&cache, kind)
                .map_err(|error| {
                    eprintln!("Cannot prepare download notification icon: {error}");
                })
                .ok()
        };
        let icons = NotificationIcons {
            brand: prepare(None),
            error: prepare(Some(NotificationKind::Error)),
            warning: prepare(Some(NotificationKind::Warning)),
        };
        let mut notifier = platform::Notifier::new(identifier, icons, target);
        let mut last_error = None;
        while let Ok(delivery) = receiver.recv() {
            let result = notifier.show(&delivery.body, delivery.update, delivery.kind);
            if let Err(error) = &result {
                if last_error.as_ref() != Some(error) {
                    eprintln!("Cannot show download notification: {error}");
                }
                last_error = Some(error.clone());
            } else {
                last_error = None;
            }
            let _ = delivery.result.send(result.is_ok());
        }
    });
    tauri::async_runtime::spawn(async move {
        let mut aggregate = Aggregate::default();
        while !core.closing.load(Ordering::SeqCst) {
            if let Ok(bridge) = core.connect().await {
                if let Ok(response) = bridge
                    .request(Request::new("GET", "/system/download-issues"))
                    .await
                {
                    if response.status == 200 {
                        if let Ok(snapshot) = serde_json::from_str::<Issues>(&response.body) {
                            let now = Instant::now();
                            aggregate.observe(snapshot, now);
                            if let Some((body, update)) = aggregate.message(now) {
                                let (result, receipt) = tokio::sync::oneshot::channel();
                                if !core.closing.load(Ordering::SeqCst) {
                                    let queued = sender
                                        .try_send(Delivery {
                                            body,
                                            update,
                                            kind: aggregate.kind(),
                                            result,
                                        })
                                        .is_ok();
                                    let accepted = queued
                                        && matches!(
                                            tokio::time::timeout(Duration::from_secs(10), receipt)
                                                .await,
                                            Ok(Ok(true))
                                        );
                                    aggregate.delivery_result(Instant::now(), accepted);
                                }
                            }
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    });
}

#[cfg(windows)]
mod platform {
    use super::{NotificationIcons, NotificationKind};
    use ::windows::{
        core::HSTRING,
        Data::Xml::Dom::XmlDocument,
        Foundation::TypedEventHandler,
        Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
        UI::Notifications::{NotificationSetting, ToastNotification, ToastNotificationManager},
    };
    pub struct Notifier {
        identifier: String,
        initialized: bool,
        icons: NotificationIcons,
        app: tauri::AppHandle,
        current: Option<ToastNotification>,
    }
    impl Notifier {
        pub fn new(identifier: String, icons: NotificationIcons, app: tauri::AppHandle) -> Self {
            let initialized = unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.is_ok();
            Self {
                identifier,
                initialized,
                icons,
                app,
                current: None,
            }
        }
        pub fn show(
            &mut self,
            body: &str,
            update: bool,
            kind: NotificationKind,
        ) -> Result<(), String> {
            if !self.initialized {
                return Err("Cannot initialize native notifications".into());
            }
            let (key, _) = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
                .create_subkey(format!(
                    "Software\\Classes\\AppUserModelId\\{}",
                    self.identifier
                ))
                .map_err(|e| e.to_string())?;
            key.set_value("DisplayName", &"TrueDown")
                .map_err(|e| e.to_string())?;
            if let Some(icon) = self
                .icons
                .brand
                .as_ref()
                .and_then(|path| tauri::Url::from_file_path(path).ok())
            {
                key.set_value("IconUri", &icon.as_str())
                    .map_err(|e| e.to_string())?;
                key.set_value("IconBackgroundColor", &"0")
                    .map_err(|e| e.to_string())?;
            }
            let icon = self
                .icons
                .get(kind)
                .and_then(|path| tauri::Url::from_file_path(path).ok())
                .map(|url| url.to_string());
            // Keep the text actionable even if the OS cannot load the image.
            self.show_content(body, update, icon.as_deref())
                .or_else(|error| {
                    if icon.is_none() {
                        return Err(error);
                    }
                    self.show_content(body, update, None)
                })
                .map(|toast| self.current = Some(toast))
        }

        fn show_content(
            &self,
            body: &str,
            update: bool,
            icon: Option<&str>,
        ) -> Result<ToastNotification, String> {
            let document = XmlDocument::new().map_err(|e| e.to_string())?;
            document
                .LoadXml(&HSTRING::from(super::toast_xml(body, icon)))
                .map_err(|e| e.to_string())?;
            let toast =
                ToastNotification::CreateToastNotification(&document).map_err(|e| e.to_string())?;
            toast
                .SetTag(&HSTRING::from("download-issues"))
                .map_err(|e| e.to_string())?;
            toast
                .SetGroup(&HSTRING::from("downloads"))
                .map_err(|e| e.to_string())?;
            toast.SetSuppressPopup(update).map_err(|e| e.to_string())?;
            let app = self.app.clone();
            toast
                .Activated(&TypedEventHandler::new(move |_, _| {
                    crate::show_main(&app);
                    Ok(())
                }))
                .map_err(|e| e.to_string())?;
            let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(
                &self.identifier,
            ))
            .map_err(|e| e.to_string())?;
            if notifier.Setting().map_err(|e| e.to_string())? != NotificationSetting::Enabled {
                return Err("System notifications are disabled".into());
            }
            notifier.Show(&toast).map_err(|e| e.to_string())?;
            Ok(toast)
        }
    }
    impl Drop for Notifier {
        fn drop(&mut self) {
            self.current = None;
            if self.initialized {
                unsafe {
                    RoUninitialize();
                }
            }
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::{NotificationIcons, NotificationKind};
    pub struct Notifier {
        #[cfg(target_os = "linux")]
        handle: Option<notify_rust::NotificationHandle>,
        icons: NotificationIcons,
    }
    impl Notifier {
        pub fn new(_identifier: String, icons: NotificationIcons, _app: tauri::AppHandle) -> Self {
            #[cfg(target_os = "macos")]
            if let Err(error) = notify_rust::set_application("io.truewayd.truedown") {
                eprintln!("Cannot identify TrueDown notifications: {error}");
            }
            Self {
                #[cfg(target_os = "linux")]
                handle: None,
                icons,
            }
        }
        pub fn show(
            &mut self,
            body: &str,
            _update: bool,
            kind: NotificationKind,
        ) -> Result<(), String> {
            let icon = self.icons.get(kind).and_then(|path| path.to_str());
            #[cfg(target_os = "linux")]
            if let Some(handle) = &mut self.handle {
                handle.body(body);
                handle.icon(icon.unwrap_or("truedown"));
                let result = handle.update().map_err(|error| error.to_string());
                if result.is_err() {
                    self.handle = None;
                }
                return result;
            }
            let mut notification = notify_rust::Notification::new();
            notification
                .summary("TrueDown 下载提示")
                .body(body)
                .appname("TrueDown");
            #[cfg(target_os = "linux")]
            notification.icon(icon.unwrap_or("truedown"));
            #[cfg(target_os = "macos")]
            if let Some(icon) = icon {
                notification.image_path(icon);
            }
            let result = notification.show().map_err(|e| e.to_string())?;
            #[cfg(target_os = "linux")]
            {
                self.handle = Some(result);
            }
            #[cfg(not(target_os = "linux"))]
            let _ = result;
            Ok(())
        }
    }
}

#[cfg(any(windows, test))]
fn toast_xml(body: &str, icon: Option<&str>) -> String {
    fn escape(value: &str) -> String {
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;")
    }
    let image = icon
        .map(|url| {
            format!(
                "<image placement=\"appLogoOverride\" src=\"{}\" alt=\"TrueDown\"/>",
                escape(url)
            )
        })
        .unwrap_or_default();
    format!("<toast><visual><binding template=\"ToastGeneric\">{image}<text>TrueDown 下载提示</text><text>{}</text></binding></visual><audio silent=\"true\"/></toast>", escape(body))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn waiting_media_is_reported_without_claiming_download_failure() {
        let now = Instant::now();
        let mut aggregate = Aggregate::default();
        let mut state = Issues {
            epoch: "one".into(),
            ..Default::default()
        };
        aggregate.observe(state.clone(), now);
        state.engine_required = 2;
        aggregate.observe(state, now);
        let (text, _) = aggregate.message(now).unwrap();
        assert!(text.contains("2 个媒体任务已保存"));
        assert!(!text.contains("下载问题"));
    }
    #[test]
    fn aggregates_transitions_without_replaying_history_or_repeated_popups() {
        let now = Instant::now();
        let mut aggregate = Aggregate::default();
        let mut state = Issues {
            epoch: "one".into(),
            downloads: 20,
            ..Default::default()
        };
        aggregate.observe(state.clone(), now);
        assert!(aggregate.message(now).is_none());
        state.downloads += 4;
        state.dropbox += 2;
        aggregate.observe(state.clone(), now);
        assert_eq!(aggregate.counts, [4, 2, 0, 0]);
        assert!(!aggregate.message(now).unwrap().1);
        aggregate.delivery_result(now, true);
        aggregate.observe(state.clone(), now);
        assert!(aggregate.message(now + Duration::from_secs(31)).is_none());
        state.google_drive += 1;
        aggregate.observe(state.clone(), now + Duration::from_secs(5));
        assert!(aggregate.message(now + Duration::from_secs(6)).is_none());
        assert!(aggregate.message(now + Duration::from_secs(31)).unwrap().1);
        state.epoch = "two".into();
        aggregate.observe(state, now + Duration::from_secs(32));
        assert!(aggregate.message(now + Duration::from_secs(32)).is_none());
    }

    #[test]
    fn failed_delivery_is_retried_without_losing_counts_or_repeating_a_popup() {
        let now = Instant::now();
        let mut aggregate = Aggregate::default();
        let mut state = Issues {
            epoch: "one".into(),
            ..Default::default()
        };
        aggregate.observe(state.clone(), now);
        state.downloads = 2;
        aggregate.observe(state.clone(), now);
        aggregate.delivery_result(now, false);
        assert!(aggregate.delivered.is_none());
        assert!(aggregate.dirty);
        assert!(aggregate.message(now + Duration::from_secs(29)).is_none());
        assert!(!aggregate.message(now + Duration::from_secs(30)).unwrap().1);
        aggregate.delivery_result(now + Duration::from_secs(30), true);
        state.downloads += 1;
        aggregate.observe(state, now + Duration::from_secs(31));
        aggregate.delivery_result(now + Duration::from_secs(60), false);
        let (message, update) = aggregate.message(now + Duration::from_secs(90)).unwrap();
        assert!(message.contains("下载问题：3"));
        assert!(update);
    }

    #[test]
    fn notification_icon_is_atomic_reusable_and_repairs_only_its_owned_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = prepare_icon(directory.path(), None).unwrap();
        let expected = include_bytes!("../icons/notification.png");
        assert_eq!(std::fs::read(&path).unwrap(), expected);
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(prepare_icon(directory.path(), None).unwrap(), path);
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            modified
        );
        let unrelated = directory.path().join("keep.txt");
        std::fs::write(&unrelated, "keep").unwrap();
        std::fs::write(&path, "damaged").unwrap();
        prepare_icon(directory.path(), None).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), expected);
        assert_eq!(std::fs::read_to_string(unrelated).unwrap(), "keep");
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            1
        );
    }

    #[test]
    fn download_errors_and_waiting_media_choose_different_business_icons() {
        let mut aggregate = Aggregate {
            counts: [0, 0, 0, 3],
            ..Default::default()
        };
        assert_eq!(aggregate.kind(), NotificationKind::Warning);
        aggregate.counts[2] = 1;
        assert_eq!(aggregate.kind(), NotificationKind::Error);
        let directory = tempfile::tempdir().unwrap();
        let error = prepare_icon(directory.path(), Some(NotificationKind::Error)).unwrap();
        let warning = prepare_icon(directory.path(), Some(NotificationKind::Warning)).unwrap();
        assert_ne!(error, warning);
        assert_ne!(
            std::fs::read(&error).unwrap(),
            std::fs::read(&warning).unwrap()
        );
        let icons = NotificationIcons {
            brand: Some(error.clone()),
            error: None,
            warning: Some(warning.clone()),
        };
        assert_eq!(icons.get(NotificationKind::Error), Some(error.as_path()));
        assert_eq!(
            icons.get(NotificationKind::Warning),
            Some(warning.as_path())
        );
    }

    #[test]
    fn toast_content_escapes_body_and_icon_and_can_omit_an_unavailable_image() {
        let xml = toast_xml("a < b & c > d", Some("file:///C:/A&B/\"icon\".png"));
        assert!(xml.contains("appLogoOverride"));
        assert!(xml.contains("a &lt; b &amp; c &gt; d"));
        assert!(xml.contains("A&amp;B/&quot;icon&quot;.png"));
        assert!(xml.contains("silent=\"true\""));
        let fallback = toast_xml("retry", None);
        assert!(!fallback.contains("<image"));
        assert!(fallback.contains("retry"));
    }
}
