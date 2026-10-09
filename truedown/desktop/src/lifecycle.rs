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
    let target = app.clone();
    let (hidden, ready) = tokio::sync::oneshot::channel();
    // Hide on the UI thread before disconnecting the core. Visibility changes
    // stop page polling while native cleanup retains process ownership.
    let _ = app.run_on_main_thread(move || {
        for window in target.webview_windows().into_values() {
            let _ = window.hide();
        }
        let _ = hidden.send(());
    });
    tauri::async_runtime::spawn(async move {
        let _ = ready.await;
        core.shutdown().await;
        app.state::<Exit>().complete.store(true, Ordering::SeqCst);
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
