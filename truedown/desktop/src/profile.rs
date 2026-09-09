use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command};

const MAX_PROFILE_OUTPUT: u64 = 64 * 1024;

pub(crate) async fn command_output(
    command: &mut Command,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot resolve the TrueDown profile: {error}"))?;
    let result = tokio::time::timeout(timeout, async {
        let stdout = child.stdout.take().ok_or("Profile output unavailable")?;
        let mut output = Vec::new();
        stdout
            .take(MAX_PROFILE_OUTPUT + 1)
            .read_to_end(&mut output)
            .await
            .map_err(|_| "Cannot read the TrueDown profile")?;
        if output.len() as u64 > MAX_PROFILE_OUTPUT {
            return Err("Profile response exceeded its limit".to_string());
        }
        if !child
            .wait()
            .await
            .map_err(|_| "Cannot wait for the profile helper")?
            .success()
        {
            return Err(
                "Cannot resolve the TrueDown profile; run truedown-cli paths for details"
                    .to_string(),
            );
        }
        Ok(output)
    })
    .await
    .unwrap_or_else(|_| Err("Profile helper timed out".to_string()));
    if result.is_err() {
        // Reap failed helpers; cancellation also terminates them via kill_on_drop.
        let _ = child.kill().await;
    }
    result
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub data_directory: String,
    pub paths: Paths,
    build: crate::build_info::Info,
}

#[derive(Deserialize)]
pub struct Paths {
    pub cache: String,
    pub state: String,
}

impl Profile {
    // The CLI delegates to Go's profile package. The shell never reconstructs
    // platform defaults, legacy discovery or configuration migration rules.
    pub async fn resolve(base: &Path, explicit: Option<&str>) -> Result<Self, String> {
        let mut command = Command::new(base.join(if cfg!(windows) {
            "truedown-cli.exe"
        } else {
            "truedown-cli"
        }));
        command.arg("--json");
        if let Some(directory) = explicit {
            command.args(["--data-dir", directory]);
        }
        command.arg("paths");
        let output = command_output(&mut command, Duration::from_secs(15)).await?;
        let profile: Self =
            serde_json::from_slice(&output).map_err(|_| "Invalid profile response")?;
        profile.build.verify()?;
        if !Path::new(&profile.data_directory).is_absolute()
            || !Path::new(&profile.paths.cache).is_absolute()
            || !Path::new(&profile.paths.state).is_absolute()
        {
            return Err("Profile path must be absolute".into());
        }
        Ok(profile)
    }

    pub fn identity(&self) -> String {
        let path = if cfg!(windows) {
            self.data_directory.to_lowercase()
        } else {
            self.data_directory.clone()
        };
        let hash = Sha256::digest(path.as_bytes());
        hash[..8].iter().map(|byte| format!("{byte:02x}")).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_command_fixture() {
        use std::io::Write;
        match std::env::var("TRUEDOWN_PROFILE_FIXTURE").as_deref() {
            Ok("overflow") => {
                std::io::stdout()
                    .write_all(&vec![b'x'; MAX_PROFILE_OUTPUT as usize + 1])
                    .unwrap();
                std::io::stdout().flush().unwrap();
                std::thread::sleep(Duration::from_secs(30));
            }
            Ok("timeout") => std::thread::sleep(Duration::from_secs(30)),
            Ok("failure") => std::process::exit(1),
            _ => {}
        }
    }

    #[test]
    fn profile_helpers_bound_output_and_runtime() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            for (mode, expected) in [
                ("overflow", "Profile response exceeded its limit"),
                ("timeout", "Profile helper timed out"),
                ("failure", "Cannot resolve the TrueDown profile"),
            ] {
                let mut command = Command::new(std::env::current_exe().unwrap());
                command
                    .args([
                        "--exact",
                        "profile::tests::profile_command_fixture",
                        "--nocapture",
                    ])
                    .env("TRUEDOWN_PROFILE_FIXTURE", mode);
                let timeout = if mode == "timeout" {
                    Duration::from_millis(100)
                } else {
                    Duration::from_secs(5)
                };
                let result = command_output(&mut command, timeout).await;
                assert!(result.unwrap_err().starts_with(expected), "{mode}");
            }
        });
    }
}
