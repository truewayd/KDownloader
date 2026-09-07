use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex as AsyncMutex},
};

const MAX_FRAME: usize = 20 * 1024 * 1024;
const ROUTES: &str = include_str!("../../internal/protocol/routes.json");

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
        let routes: HashMap<String, Vec<String>> =
            serde_json::from_str(ROUTES).map_err(|_| "Invalid compiled API contract")?;
        if self.path.len() > 8192
            || self.path.contains(['\r', '\n', '#'])
            || self.body.len() > 6 * 1024 * 1024
            || !routes
                .get(path)
                .is_some_and(|methods| methods.contains(&self.method))
        {
            return Err("Unsupported desktop request".into());
        }
        for (key, value) in &self.headers {
            if !["content-type", "if-none-match"].contains(&key.to_ascii_lowercase().as_str())
                || value.len() > 1024
                || value.contains(['\r', '\n', '\0'])
            {
                return Err("Unsupported desktop request header".into());
            }
        }
        Ok(())
    }
}

pub struct Bridge {
    child: AsyncMutex<Child>,
    input: AsyncMutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Response, String>>>>,
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
        if let Some(stderr) = child.stderr.take() {
            tauri::async_runtime::spawn(async move {
                let mut reader = BufReader::new(stderr);
                while read_frame(&mut reader).await.is_ok() {}
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
        let mut value = serde_json::to_value(request).map_err(|_| "Cannot encode core request")?;
        value["id"] = id.into();
        let mut data = serde_json::to_vec(&value).map_err(|_| "Cannot encode core request")?;
        data.push(b'\n');
        if data.len() > 8 * 1024 * 1024 {
            return Err("Desktop request frame exceeds its limit".into());
        }
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            if pending.len() >= 32 {
                return Err("Too many pending core requests".into());
            }
            pending.insert(id, sender);
        }
        let sent = {
            let mut input = self.input.lock().await;
            match input.as_mut() {
                Some(input) => {
                    match tokio::time::timeout(Duration::from_secs(10), input.write_all(&data))
                        .await
                    {
                        Ok(result) => result.map_err(|_| "Core pipe write failed".to_string()),
                        Err(_) => Err("Core pipe write timed out".to_string()),
                    }
                }
                None => Err("Core disconnected".into()),
            }
        };
        if let Err(error) = sent {
            self.alive.store(false, Ordering::SeqCst);
            self.pending.lock().unwrap().remove(&id);
            return Err(error);
        }
        let response = tokio::time::timeout(Duration::from_secs(365), receiver).await;
        self.pending.lock().unwrap().remove(&id);
        response
            .map_err(|_| "Core request timed out".to_string())?
            .map_err(|_| "Core disconnected".to_string())?
    }
    pub async fn shutdown(&self) -> bool {
        // EOF stops an owned core gracefully and only detaches an attached bridge.
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
    #[test]
    fn rejects_arbitrary_native_requests() {
        for path in [
            "/../../secrets",
            "https://example.com/tasks",
            "//example.com/tasks",
            "/tasks#fragment",
            "/tasks/open-arbitrary",
        ] {
            assert!(Request::new("GET", path).validate().is_err());
        }
        assert!(Request::new("GET", "/tasks?limit=100").validate().is_ok());
        assert!(Request::new("POST", "/tasks").validate().is_err());
        let mut request = Request::new("GET", "/tasks");
        request.headers.insert("X-Api-Key".into(), "private".into());
        assert!(request.validate().is_err());
    }
}
