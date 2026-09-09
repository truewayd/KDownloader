use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex as AsyncMutex},
};

const MAX_FRAME: usize = 20 * 1024 * 1024;
static ROUTES: LazyLock<Result<HashMap<&str, Vec<&str>>, serde_json::Error>> =
    LazyLock::new(|| serde_json::from_str(include_str!("../../internal/protocol/routes.json")));

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
}
#[derive(Clone, Deserialize, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    #[serde(default)]
    pub id: u64,
    #[serde(default)]
    pub event: String,
    #[serde(default)]
    pub protocol_version: u32,
    #[serde(default)]
    pub owned: bool,
    #[serde(default)]
    pub status: u16,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub error: String,
}
impl Request {
    pub fn new(method: &str, path: &str) -> Self {
        Self {
            method: method.into(),
            path: path.into(),
            body: String::new(),
            headers: HashMap::new(),
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        let path = self.path.split('?').next().unwrap_or("");
        let routes = ROUTES
            .as_ref()
            .map_err(|_| "Invalid compiled API contract")?;
        if self.path.len() > 8192
            || self.path.contains('#')
            || self.path.bytes().any(|byte| byte.is_ascii_control())
            || self.body.len() > 6 * 1024 * 1024
            || self.headers.len() > 2
            || !routes
                .get(path)
                .is_some_and(|methods| methods.contains(&self.method.as_str()))
        {
            return Err("Unsupported desktop request".into());
        }
        let mut names = std::collections::HashSet::new();
        for (key, value) in &self.headers {
            if !(key.eq_ignore_ascii_case("content-type")
                || key.eq_ignore_ascii_case("if-none-match"))
                || value.len() > 1024
                || value.contains(['\r', '\n', '\0'])
                || !names.insert(key.to_ascii_lowercase())
            {
                return Err("Unsupported desktop request header".into());
            }
        }
        Ok(())
    }

    fn into_frame(self, id: u64) -> Result<Vec<u8>, String> {
        #[derive(Serialize)]
        struct Frame {
            id: u64,
            #[serde(flatten)]
            request: Request,
        }

        let mut data = serde_json::to_vec(&Frame { id, request: self })
            .map_err(|_| "Cannot encode core request")?;
        data.push(b'\n');
        if data.len() > 8 * 1024 * 1024 {
            return Err("Desktop request frame exceeds its limit".into());
        }
        Ok(data)
    }
}

type PendingMap = Mutex<HashMap<u64, oneshot::Sender<Result<Response, String>>>>;

struct PendingRequest<'a> {
    pending: &'a PendingMap,
    id: u64,
}

impl<'a> PendingRequest<'a> {
    fn reserve(
        pending: &'a PendingMap,
        alive: &AtomicBool,
        id: u64,
    ) -> Result<(Self, oneshot::Receiver<Result<Response, String>>), String> {
        let mut entries = pending.lock().unwrap();
        if !alive.load(Ordering::SeqCst) {
            return Err("Core disconnected".into());
        }
        if entries.len() >= 32 {
            return Err("Too many pending core requests".into());
        }
        let (sender, receiver) = oneshot::channel();
        entries.insert(id, sender);
        Ok((Self { pending, id }, receiver))
    }
}

impl Drop for PendingRequest<'_> {
    fn drop(&mut self) {
        // Also release capacity if the caller cancels while queued for a pipe
        // write or waiting for a response that never arrives.
        self.pending.lock().unwrap().remove(&self.id);
    }
}

struct WritingFrame<'a> {
    alive: &'a AtomicBool,
    completed: bool,
}

impl Drop for WritingFrame<'_> {
    fn drop(&mut self) {
        if !self.completed {
            // A failed or cancelled write_all may already have sent a prefix.
            // Mark it dead before releasing the pipe lock; never append a new
            // request to an uncertain frame or replay the cancelled request.
            self.alive.store(false, Ordering::SeqCst);
        }
    }
}

async fn write_frame<W: AsyncWrite + Unpin>(
    input: &AsyncMutex<Option<W>>,
    alive: &AtomicBool,
    data: &[u8],
) -> Result<(), String> {
    let mut input = input.lock().await;
    // A previous writer may have failed, or shutdown may have started while
    // this request was queued. Never send another uncertain frame afterward.
    if !alive.load(Ordering::SeqCst) {
        return Err("Core disconnected".into());
    }
    let mut writing = WritingFrame {
        alive,
        completed: false,
    };
    let result = match input.as_mut() {
        Some(input) => {
            match tokio::time::timeout(Duration::from_secs(10), input.write_all(data)).await {
                Ok(result) => result.map_err(|_| "Core pipe write failed".to_string()),
                Err(_) => Err("Core pipe write timed out".to_string()),
            }
        }
        None => Err("Core disconnected".into()),
    };
    writing.completed = result.is_ok();
    result
}

pub struct Bridge {
    child: AsyncMutex<Child>,
    input: AsyncMutex<Option<ChildStdin>>,
    pending: PendingMap,
    next_id: AtomicU64,
    pub alive: AtomicBool,
    pub owned: bool,
}
pub async fn read_frame<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Vec<u8>, String> {
    let mut frame = Vec::new();
    loop {
        let available = reader
            .fill_buf()
            .await
            .map_err(|_| "Core pipe read failed")?;
        if available.is_empty() {
            return Err("Core disconnected".into());
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let count = newline.map_or(available.len(), |at| at + 1);
        if frame.len() + count > MAX_FRAME {
            return Err("Core frame exceeds its limit".into());
        }
        frame.extend_from_slice(&available[..count]);
        reader.consume(count);
        if newline.is_some() {
            return Ok(frame);
        }
    }
}
impl Bridge {
    pub async fn spawn(
        executable: PathBuf,
        data_dir: Option<&str>,
        attach_only: bool,
        recovering: bool,
    ) -> Result<Arc<Self>, String> {
        let mut command = Command::new(executable);
        command.env(
            "TRUEDOWN_DESKTOP_EXECUTABLE",
            std::env::current_exe().map_err(|error| error.to_string())?,
        );
        // Only the native window can acknowledge a full bundle's health.
        command.env_remove("TRUEDOWN_UPDATE_HEALTH_FILE");
        command.env_remove("TRUEDOWN_UPDATE_HEALTH_TOKEN");
        command.env_remove("TRUEDOWN_UPDATE_BYPASS");
        command.env_remove("TRUEDOWN_UPDATE_EXPECTED_BUILD");
        command.arg("--desktop-stdio");
        if attach_only {
            command.arg("--desktop-attach-only");
        }
        if recovering {
            command.env("TRUEDOWN_ENGINE_RELAUNCH", "1");
        }
        if let Some(directory) = data_dir {
            command.args(["--data-dir", directory]);
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .map_err(|error| format!("Cannot start the TrueDown core: {error}"))?;
        let input = child.stdin.take().ok_or("Core input unavailable")?;
        let output = child.stdout.take().ok_or("Core output unavailable")?;
        // The application owns a rotating log. Consume stderr to prevent a pipe
        // deadlock; request bodies and API tokens are never logged here.
        if let Some(mut stderr) = child.stderr.take() {
            tauri::async_runtime::spawn(async move {
                let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
            });
        }
        let mut reader = BufReader::new(output);
        let ready = tokio::time::timeout(Duration::from_secs(60), read_frame(&mut reader)).await;
        let ready: Result<Response, String> = match ready {
            Ok(Ok(frame)) => {
                serde_json::from_slice(&frame).map_err(|_| "Invalid core handshake".to_string())
            }
            _ => Err("Core startup failed; inspect the application log".into()),
        }
        .and_then(|value: Response| {
            if value.event == "ready" && value.protocol_version == 1 {
                Ok(value)
            } else {
                Err("Incompatible core protocol".into())
            }
        });
        let ready = match ready {
            Ok(ready) => ready,
            Err(error) => {
                drop(input);
                let _ = child.kill().await;
                return Err(error);
            }
        };
        let bridge = Arc::new(Self {
            child: AsyncMutex::new(child),
            input: AsyncMutex::new(Some(input)),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            alive: AtomicBool::new(true),
            owned: ready.owned,
        });
        let consumer = bridge.clone();
        tauri::async_runtime::spawn(async move {
            while let Ok(frame) = read_frame(&mut reader).await {
                let Ok(response) = serde_json::from_slice::<Response>(&frame) else {
                    break;
                };
                if let Some(sender) = consumer.pending.lock().unwrap().remove(&response.id) {
                    let result = if response.error.is_empty() {
                        Ok(response)
                    } else {
                        Err(response.error)
                    };
                    let _ = sender.send(result);
                }
            }
            consumer.alive.store(false, Ordering::SeqCst);
            for (_, sender) in consumer.pending.lock().unwrap().drain() {
                let _ = sender.send(Err("Core disconnected".into()));
            }
        });
        Ok(bridge)
    }
    pub async fn request(&self, request: Request) -> Result<Response, String> {
        request.validate()?;
        if !self.alive.load(Ordering::SeqCst) {
            return Err("Core disconnected".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        // Reserve before serializing large torrent bodies so rejected bursts
        // do not allocate another full frame after capacity has been reached.
        let (_pending, receiver) = PendingRequest::reserve(&self.pending, &self.alive, id)?;
        let data = request.into_frame(id)?;
        let sent = write_frame(&self.input, &self.alive, &data).await;
        // Large torrent payloads need not remain allocated during resolver waits.
        drop(data);
        if let Err(error) = sent {
            self.alive.store(false, Ordering::SeqCst);
            return Err(error);
        }
        let response = tokio::time::timeout(Duration::from_secs(365), receiver).await;
        response
            .map_err(|_| "Core request timed out".to_string())?
            .map_err(|_| "Core disconnected".to_string())?
    }
    pub async fn shutdown(&self) -> bool {
        // EOF stops an owned core gracefully and only detaches an attached bridge.
        self.alive.store(false, Ordering::SeqCst);
        self.input.lock().await.take();
        let mut child = self.child.lock().await;
        let clean = match tokio::time::timeout(Duration::from_secs(15), child.wait()).await {
            Ok(Ok(status)) => status.success(),
            _ => {
                let _ = child.kill().await;
                false
            }
        };
        self.alive.store(false, Ordering::SeqCst);
        clean
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        future::Future,
        task::{Context, Waker},
    };

    #[test]
    fn queued_writers_stop_after_shutdown_without_writing_another_frame() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let (writer, _reader) = tokio::io::duplex(16);
            let input = AsyncMutex::new(Some(writer));
            let alive = AtomicBool::new(true);
            let held = input.lock().await;
            let mut queued: Vec<_> = (0..32)
                .map(|_| Box::pin(write_frame(&input, &alive, b"request\n")))
                .collect();
            for request in &mut queued {
                assert!(request
                    .as_mut()
                    .poll(&mut Context::from_waker(Waker::noop()))
                    .is_pending());
            }
            alive.store(false, Ordering::SeqCst);
            drop(held);
            for request in queued {
                assert_eq!(request.await.unwrap_err(), "Core disconnected");
            }
        });
    }

    #[test]
    fn cancelled_requests_release_capacity_and_partial_writes_poison_the_pipe() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let pending = PendingMap::default();
            let alive = AtomicBool::new(true);
            let mut cancelled = Box::pin(async {
                let (_entry, _receiver) = PendingRequest::reserve(&pending, &alive, 1).unwrap();
                std::future::pending::<()>().await;
            });
            assert!(cancelled
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending());
            assert_eq!(pending.lock().unwrap().len(), 1);
            drop(cancelled);
            assert!(pending.lock().unwrap().is_empty());
            let slots: Vec<_> = (2..34)
                .map(|id| PendingRequest::reserve(&pending, &alive, id).unwrap())
                .collect();
            assert!(PendingRequest::reserve(&pending, &alive, 34).is_err());
            drop(slots);
            assert!(pending.lock().unwrap().is_empty());

            let (writer, _reader) = tokio::io::duplex(1);
            let input = AsyncMutex::new(Some(writer));
            let mut partial = Box::pin(write_frame(&input, &alive, b"partial-frame\n"));
            assert!(partial
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending());
            drop(partial);
            assert!(!alive.load(Ordering::SeqCst));
            assert_eq!(
                write_frame(&input, &alive, b"next-frame\n")
                    .await
                    .unwrap_err(),
                "Core disconnected"
            );
        });
    }

    #[test]
    fn request_frames_preserve_the_protocol_and_bound_escaped_bodies() {
        let mut request = Request::new("POST", "/settings/runtime");
        request.body = "{\"value\":\"a\\b\"}\n".into();
        request
            .headers
            .insert("Content-Type".into(), "application/json".into());
        assert!(request.validate().is_ok());
        let frame = request.into_frame(42).unwrap();
        assert_eq!(frame.last(), Some(&b'\n'));
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&frame).unwrap(),
            serde_json::json!({
                "id": 42,
                "method": "POST",
                "path": "/settings/runtime",
                "body": "{\"value\":\"a\\b\"}\n",
                "headers": {"Content-Type": "application/json"},
            })
        );

        let mut request = Request::new("POST", "/start-bt-download");
        request.body = "\0".repeat(2 * 1024 * 1024);
        assert!(request.validate().is_ok());
        assert_eq!(
            request.into_frame(43).unwrap_err(),
            "Desktop request frame exceeds its limit"
        );
    }

    #[test]
    fn rejects_arbitrary_native_requests() {
        for path in [
            "/../../secrets",
            "https://example.com/tasks",
            "//example.com/tasks",
            "/tasks#fragment",
            "/tasks/open-arbitrary",
            "/tasks?search=\0",
            "/tasks?search=\u{7f}",
        ] {
            assert!(Request::new("GET", path).validate().is_err());
        }
        assert!(Request::new("GET", "/tasks?limit=100").validate().is_ok());
        assert!(Request::new("POST", "/tasks").validate().is_err());
        let mut request = Request::new("GET", "/tasks");
        request.headers.insert("X-Api-Key".into(), "private".into());
        assert!(request.validate().is_err());
        request.headers.clear();
        request
            .headers
            .insert("Content-Type".into(), "application/json".into());
        request
            .headers
            .insert("content-type".into(), "text/plain".into());
        assert!(request.validate().is_err());
    }
}
