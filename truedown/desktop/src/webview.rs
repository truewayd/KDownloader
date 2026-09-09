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
        #[cfg(all(windows, debug_assertions))]
        let builder = match test_browser_arguments(
            std::env::var("TRUEDOWN_DESKTOP_TEST_DEBUG_PORT")
                .ok()
                .as_deref(),
        ) {
            Some(arguments) => builder.additional_browser_args(&arguments),
            None => builder,
        };
        #[cfg(target_os = "macos")]
        {
            // WKWebView ignores data_directory. Named stores are available
            // starting with macOS 14; older systems use ephemeral website data
            // so unrelated profiles cannot share cookies or localStorage.
            let version = objc2_foundation::NSProcessInfo::processInfo().operatingSystemVersion();
            if version.majorVersion >= 14 {
                builder.data_store_identifier(self.identifier)
            } else {
                builder.incognito(true)
            }
        }
        #[cfg(not(target_os = "macos"))]
        builder
    }
}

#[cfg(any(all(windows, debug_assertions), test))]
fn test_browser_arguments(port: Option<&str>) -> Option<String> {
    let port = port?;
    if port.is_empty() || port.len() > 5 || !port.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let port = port.parse::<u16>().ok().filter(|port| *port != 0)?;
    // Elevated WebView2 150+ ignores WEBVIEW2_* overrides. Debug fixtures use
    // the native API, retaining Wry's default arguments; release builds omit it.
    Some(format!(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}"
    ))
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
    fn acceptance_debugging_accepts_only_a_nonzero_port() {
        for port in [
            None,
            Some(""),
            Some("0"),
            Some("65536"),
            Some("+9222"),
            Some(" 9222"),
            Some("9222 "),
            Some("9222 --no-sandbox"),
        ] {
            assert!(super::test_browser_arguments(port).is_none());
        }
        for port in ["1", "9222", "65535"] {
            assert_eq!(
                super::test_browser_arguments(Some(port)).unwrap(),
                format!("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}")
            );
        }
    }

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
