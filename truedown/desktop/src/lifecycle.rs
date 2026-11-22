use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::Manager;

#[derive(Default)]
pub struct Exit {
    requested: AtomicBool,
    complete: AtomicBool,
}

impl Exit {
    fn begin(&self) -> bool {
        !self.requested.swap(true, Ordering::SeqCst)
    }
    pub fn complete(&self) -> bool {
        self.complete.load(Ordering::SeqCst)
    }
}

pub fn request(app: &tauri::AppHandle) {
    if !app.state::<Exit>().begin() {
        return;
    }
    let core = app.state::<Arc<crate::core::Core>>().inner().clone();
    core.closing.store(true, Ordering::SeqCst);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let target = app.clone();
        let (hidden, ready) = tokio::sync::oneshot::channel();
        // Dispatch from the worker. Tauri runs this inline if called by a tray
        // event on the UI thread, which would prevent the timeout from starting.
        let _ = app.run_on_main_thread(move || {
            if let Some(tray) = target.tray_by_id("main-tray") {
                let _ = tray.set_visible(false);
            }
            for window in target.webview_windows().into_values() {
                let _ = window.hide();
            }
            let _ = hidden.send(());
        });
        #[cfg(windows)]
        if tokio::time::timeout(std::time::Duration::from_secs(2), ready)
            .await
            .is_err()
        {
            eprintln!("TrueDown window shutdown did not respond; stopping the core");
        }
        #[cfg(not(windows))]
        let _ = ready.await;
        core.shutdown().await;
        app.state::<Exit>().complete.store(true, Ordering::SeqCst);
        // The core and its engine are already shut down. Allow Tauri to
        // tear down the WebView and tray, then release a wedged Windows shell.
        #[cfg(windows)]
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_secs(5));
            eprintln!("TrueDown native exit timed out after core shutdown");
            std::process::exit(0);
        });
        app.exit(0);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_exit_cannot_skip_pending_cleanup() {
        let state = Exit::default();
        assert!(state.begin());
        assert!(!state.begin());
        assert!(!state.complete());
        state.complete.store(true, Ordering::SeqCst);
        assert!(state.complete());
        assert!(!state.begin());
    }
}
