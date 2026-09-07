use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    process::{Command, Stdio},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub data_directory: String,
}

impl Profile {
    // The CLI delegates to Go's profile package. The shell never reconstructs
    // platform defaults, legacy discovery or configuration migration rules.
    pub fn resolve(base: &Path, explicit: Option<&str>) -> Result<Self, String> {
        let mut command = Command::new(base.join(if cfg!(windows) {
            "truedown-cli.exe"
        } else {
            "truedown-cli"
        }));
        command.arg("--json");
        if let Some(directory) = explicit {
            command.args(["--data-dir", directory]);
        }
        command.arg("paths").stdin(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let output = command
            .output()
            .map_err(|error| format!("Cannot resolve the TrueDown profile: {error}"))?;
        if !output.status.success() || output.stdout.len() > 64 * 1024 {
            return Err(
                "Cannot resolve the TrueDown profile; run truedown-cli paths for details".into(),
            );
        }
        let profile: Self =
            serde_json::from_slice(&output.stdout).map_err(|_| "Invalid profile response")?;
        if !Path::new(&profile.data_directory).is_absolute() {
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
