use crate::profile::Profile;
use std::path::PathBuf;
use tauri::{Manager, WebviewWindowBuilder, Wry};

pub struct Storage {
    cache: PathBuf,
    #[cfg(target_os = "macos")]
    identifier: [u8; 16],
}

impl Storage {
    pub fn new(profile: &Profile) -> Self {
        Self {
            cache: PathBuf::from(&profile.paths.cache).join("webview"),
            #[cfg(target_os = "macos")]
            identifier: identifier(&profile.data_directory),
        }
    }

    pub fn configure<'a, M: Manager<Wry>>(
        &self,
        builder: WebviewWindowBuilder<'a, Wry, M>,
    ) -> WebviewWindowBuilder<'a, Wry, M> {
        let builder = builder.data_directory(self.cache.clone());
        #[cfg(target_os = "macos")]
        {
            // WKWebView ignores data_directory. Named stores are available
            // starting with macOS 14; older systems use ephemeral website data
            // so unrelated profiles cannot share cookies or localStorage.
            let version = objc2_foundation::NSProcessInfo::processInfo().operatingSystemVersion();
            if version.majorVersion >= 14 {
                return builder.data_store_identifier(self.identifier);
            }
            return builder.incognito(true);
        }
        #[cfg(not(target_os = "macos"))]
        builder
    }
}

#[cfg(any(target_os = "macos", test))]
fn identifier(profile: &str) -> [u8; 16] {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(profile.as_bytes());
    digest[..16].try_into().unwrap()
}

#[cfg(test)]
mod tests {
    #[test]
    fn website_stores_are_stable_and_profile_scoped() {
        assert_eq!(
            super::identifier("/a/profile"),
            super::identifier("/a/profile")
        );
        assert_ne!(
            super::identifier("/a/profile"),
            super::identifier("/b/profile")
        );
    }
}
