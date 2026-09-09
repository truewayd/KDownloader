use crate::bridge::Bridge;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

pub struct Core {
    session: Mutex<Session>,
    shutdown: Mutex<()>,
    executable: PathBuf,
    data_dir: Option<String>,
    pub closing: AtomicBool,
    pub exited: AtomicBool,
    pub owned: AtomicBool,
}

struct Session {
    bridge: Option<Arc<Bridge>>,
    failure: Option<String>,
    recovery: Recovery,
    retry_at: Option<Instant>,
    attach_only: bool,
    started: bool,
}

struct Recovery {
    attempts: u8,
    healthy_since: Instant,
}

impl Recovery {
    fn admit(&mut self) -> bool {
        if self.attempts >= 3 {
            return false;
        }
        self.attempts += 1;
        true
    }
    fn healthy(&mut self, now: Instant) {
        if now.duration_since(self.healthy_since) >= Duration::from_secs(120) {
            self.attempts = 0;
        }
    }
}

impl Core {
    pub fn new(executable: PathBuf, data_dir: Option<String>) -> Self {
        Self {
            session: Mutex::new(Session {
                bridge: None,
                failure: None,
                retry_at: None,
                attach_only: false,
                started: false,
                recovery: Recovery {
                    attempts: 0,
                    healthy_since: Instant::now(),
                },
            }),
            shutdown: Mutex::new(()),
            executable,
            data_dir,
            closing: AtomicBool::new(false),
            exited: AtomicBool::new(false),
            owned: AtomicBool::new(false),
        }
    }

    pub async fn connect(&self) -> Result<Arc<Bridge>, String> {
        if self.closing.load(Ordering::SeqCst) {
            return Err("TrueDown is shutting down".into());
        }
        let mut session = self.session.lock().await;
        if self.closing.load(Ordering::SeqCst) {
            return Err("TrueDown is shutting down".into());
        }
        if let Some(error) = &session.failure {
            return Err(error.clone());
        }
        if let Some(bridge) = session.bridge.clone() {
            if bridge.alive.load(Ordering::SeqCst) {
                session.recovery.healthy(Instant::now());
                return Ok(bridge);
            }
            let clean = bridge.shutdown().await;
            session.bridge = None;
            if clean && bridge.owned {
                // An authenticated CLI/browser exit must remain an exit.
                self.exited.store(true, Ordering::SeqCst);
                return Err("TrueDown core stopped".into());
            }
            session.attach_only = !bridge.owned;
            // Unix engines also use aria2's parent-process watch; allow it to
            // finish before admitting the same durable tasks to another engine.
            session.retry_at =
                Some(Instant::now() + Duration::from_secs(if cfg!(windows) { 1 } else { 15 }));
        }
        if self.exited.load(Ordering::SeqCst) {
            return Err("TrueDown core stopped".into());
        }
        if session.retry_at.is_some_and(|at| Instant::now() < at) {
            return Err("TrueDown core is recovering".into());
        }
        if session.started && !session.recovery.admit() {
            let error = "TrueDown core recovery failed after three attempts; inspect the application log and reopen TrueDown".to_string();
            session.failure = Some(error.clone());
            return Err(error);
        }
        let recovering = session.started;
        session.started = true;
        match Bridge::spawn(
            self.executable.clone(),
            self.data_dir.as_deref(),
            session.attach_only,
            recovering,
        )
        .await
        {
            Ok(bridge) => {
                if bridge.owned {
                    let identity = bridge
                        .request(crate::bridge::Request::new("GET", "/system/info"))
                        .await
                        .and_then(|response| {
                            serde_json::from_str::<crate::build_info::Info>(&response.body)
                                .map_err(|_| "Invalid core build identity".to_string())
                        })
                        .and_then(|identity| identity.verify());
                    if let Err(error) = identity {
                        bridge.shutdown().await;
                        session.failure = Some(error.clone());
                        return Err(error);
                    }
                }
                session.retry_at = None;
                self.owned.store(bridge.owned, Ordering::SeqCst);
                session.recovery.healthy_since = Instant::now();
                session.bridge = Some(bridge.clone());
                if self.closing.load(Ordering::SeqCst) {
                    bridge.shutdown().await;
                    return Err("TrueDown is shutting down".into());
                }
                Ok(bridge)
            }
            Err(error) => {
                if recovering {
                    session.retry_at = Some(Instant::now() + Duration::from_secs(3));
                } else {
                    session.failure = Some(error.clone());
                }
                Err(error)
            }
        }
    }

    pub async fn shutdown(&self) {
        self.closing.store(true, Ordering::SeqCst);
        // All exit callers await the same cleanup. A second tray/HTTP exit
        // must not close the shell while the first is still stopping its core.
        let _completion = self.shutdown.lock().await;
        let bridge = self.session.lock().await.bridge.clone();
        if let Some(bridge) = bridge {
            bridge.shutdown().await;
            // Retain ownership until cleanup completes, including if an async
            // caller is cancelled. No session-state lock spans child I/O.
            self.session.lock().await.bridge = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_shutdown_callers_wait_for_the_same_cleanup() {
        use std::{
            future::Future,
            task::{Context, Waker},
        };
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let core = Core::new(PathBuf::from("unused-core"), None);
            let session = core.session.lock().await;
            let mut first = Box::pin(core.shutdown());
            let mut second = Box::pin(core.shutdown());
            assert!(first
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending());
            assert!(core.closing.load(Ordering::SeqCst));
            assert!(second
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending());
            drop(session);
            first.await;
            second.await;
            assert!(core.shutdown.try_lock().is_ok());
        });
    }

    #[test]
    fn queued_connection_does_not_start_a_core_after_shutdown() {
        use std::{
            future::Future,
            task::{Context, Waker},
        };

        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let core = Core::new(PathBuf::from("missing-core"), None);
            let session = core.session.lock().await;
            let mut connect = Box::pin(core.connect());
            assert!(connect
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending());
            core.closing.store(true, Ordering::SeqCst);
            drop(session);

            assert_eq!(
                connect.await.err().as_deref(),
                Some("TrueDown is shutting down")
            );
            assert!(!core.session.lock().await.started);
        });
    }

    #[test]
    fn recovery_is_bounded_until_a_sustained_healthy_period() {
        let now = Instant::now();
        let mut recovery = Recovery {
            attempts: 0,
            healthy_since: now,
        };
        for _ in 0..3 {
            assert!(recovery.admit());
        }
        assert!(!recovery.admit());
        recovery.healthy(now + Duration::from_secs(119));
        assert!(!recovery.admit());
        recovery.healthy(now + Duration::from_secs(120));
        assert!(recovery.admit());
    }
}
