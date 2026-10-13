use crate::{bridge::Request, core::Core, windows::Windows};
use serde::Deserialize;
use std::{
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};
use tauri::Manager;

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
    dirty: bool,
}

impl Aggregate {
    fn observe(&mut self, snapshot: Issues, now: Instant) {
        let Some(previous) = self.previous.replace(snapshot.clone()) else {
            return;
        };
        if previous.epoch != snapshot.epoch {
            self.counts = [0; 4];
            self.delivered = None;
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
                .delivered
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
}

pub fn start(app: &tauri::AppHandle, core: Arc<Core>) {
    if app.state::<Windows>().suppress {
        return;
    }
    let identifier = app.config().identifier.clone();
    let (sender, receiver) = std::sync::mpsc::sync_channel::<(String, bool)>(1);
    std::thread::spawn(move || {
        let mut notifier = platform::Notifier::new(identifier);
        while let Ok((body, update)) = receiver.recv() {
            if let Err(error) = notifier.show(&body, update) {
                eprintln!("Cannot show download notification: {error}");
            }
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
                            if let Some(message) = aggregate.message(now) {
                                if !core.closing.load(Ordering::SeqCst)
                                    && sender.try_send(message).is_ok()
                                {
                                    aggregate.delivered = Some(now);
                                    aggregate.dirty = false;
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
    use ::windows::{
        core::HSTRING,
        Data::Xml::Dom::XmlDocument,
        Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
        UI::Notifications::{ToastNotification, ToastNotificationManager},
    };
    pub struct Notifier {
        identifier: String,
        initialized: bool,
    }
    impl Notifier {
        pub fn new(identifier: String) -> Self {
            let initialized = unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.is_ok();
            Self {
                identifier,
                initialized,
            }
        }
        pub fn show(&mut self, body: &str, update: bool) -> Result<(), String> {
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
            let escaped = body
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;");
            let document = XmlDocument::new().map_err(|e| e.to_string())?;
            document.LoadXml(&HSTRING::from(format!("<toast><visual><binding template=\"ToastGeneric\"><text>TrueDown 下载提示</text><text>{escaped}</text></binding></visual><audio silent=\"true\"/></toast>"))).map_err(|e| e.to_string())?;
            let toast =
                ToastNotification::CreateToastNotification(&document).map_err(|e| e.to_string())?;
            toast
                .SetTag(&HSTRING::from("download-issues"))
                .map_err(|e| e.to_string())?;
            toast
                .SetGroup(&HSTRING::from("downloads"))
                .map_err(|e| e.to_string())?;
            toast.SetSuppressPopup(update).map_err(|e| e.to_string())?;
            ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(&self.identifier))
                .and_then(|notifier| notifier.Show(&toast))
                .map_err(|e| e.to_string())
        }
    }
    impl Drop for Notifier {
        fn drop(&mut self) {
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
    pub struct Notifier {
        #[cfg(target_os = "linux")]
        handle: Option<notify_rust::NotificationHandle>,
    }
    impl Notifier {
        pub fn new(_identifier: String) -> Self {
            Self {
                #[cfg(target_os = "linux")]
                handle: None,
            }
        }
        pub fn show(&mut self, body: &str, _update: bool) -> Result<(), String> {
            #[cfg(target_os = "linux")]
            if let Some(handle) = &mut self.handle {
                handle.body(body);
                return handle.update().map_err(|error| error.to_string());
            }
            let result = notify_rust::Notification::new()
                .summary("TrueDown 下载提示")
                .body(body)
                .appname("TrueDown")
                .show()
                .map_err(|e| e.to_string())?;
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
        aggregate.delivered = Some(now);
        aggregate.dirty = false;
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
}
