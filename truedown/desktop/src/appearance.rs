use tauri::WebviewWindow;

#[cfg(windows)]
#[derive(Default)]
pub struct Materials(std::sync::Mutex<std::collections::HashMap<String, (bool, bool)>>);

// Native backdrop attributes belong to an HWND, not to the retained WebView.
// Restore them before the replacement shell is shown, without waiting for a
// DOM focus event (which need not fire when the document remains focused).
#[cfg(windows)]
pub async fn restore(window: &WebviewWindow) -> Result<(), String> {
    use tauri::Manager;
    let owned = window.clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread(move || {
            let preference = owned
                .state::<Materials>()
                .0
                .lock()
                .ok()
                .and_then(|states| states.get(owned.label()).copied());
            let result = if let Some((enabled, dark)) = preference {
                let applied = apply(&owned, enabled, dark);
                owned
                    .eval(format!(
                        "document.documentElement.dataset.material = '{}';",
                        if applied { "native" } else { "solid" }
                    ))
                    .map_err(|e| e.to_string())
            } else {
                Ok(())
            };
            let _ = sender.send(result);
        })
        .map_err(|e| e.to_string())?;
    receiver.await.map_err(|e| e.to_string())?
}

pub fn initialization() -> &'static str {
    if cfg!(windows) {
        "window.__TRUEDOWN_PLATFORM__ = 'windows';"
    } else if cfg!(target_os = "macos") {
        "window.__TRUEDOWN_PLATFORM__ = 'macos';"
    } else {
        "window.__TRUEDOWN_PLATFORM__ = 'linux';"
    }
}

#[tauri::command]
pub fn apply_material(window: WebviewWindow, enabled: bool, dark: bool) -> bool {
    #[cfg(windows)]
    if matches!(
        window.label(),
        "main" | "settings" | "new-task" | "task-details"
    ) {
        use tauri::Manager;
        if let Ok(mut states) = window.state::<Materials>().0.lock() {
            states.insert(window.label().to_owned(), (enabled, dark));
        }
    }
    apply(&window, enabled, dark)
}

fn apply(window: &WebviewWindow, enabled: bool, dark: bool) -> bool {
    #[cfg(not(windows))]
    let _ = dark;
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Graphics::Dwm::{
                DwmExtendFrameIntoClientArea, DwmSetWindowAttribute, DWMWA_USE_IMMERSIVE_DARK_MODE,
            },
            UI::{
                Accessibility::{HCF_HIGHCONTRASTON, HIGHCONTRASTW},
                Controls::MARGINS,
                WindowsAndMessaging::{SystemParametersInfoW, SPI_GETHIGHCONTRAST},
            },
        };
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        let transparent = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize")
            .ok()
            .and_then(|key| key.get_value::<u32, _>("EnableTransparency").ok())
            .unwrap_or(1)
            != 0;
        let mut contrast = HIGHCONTRASTW {
            cbSize: std::mem::size_of::<HIGHCONTRASTW>() as u32,
            ..Default::default()
        };
        let contrast_available = unsafe {
            SystemParametersInfoW(
                SPI_GETHIGHCONTRAST,
                contrast.cbSize,
                (&mut contrast as *mut HIGHCONTRASTW).cast(),
                0,
            ) != 0
        };
        if enabled
            && transparent
            && contrast_available
            && contrast.dwFlags & HCF_HIGHCONTRASTON == 0
            && window_vibrancy::apply_mica(window, Some(dark)).is_ok()
        {
            // Confirmations keep the standard OS caption, so they do not pass
            // through our custom frame's full-client backdrop extension.
            if window.label().starts_with("confirmation-") {
                if let Ok(handle) = window.hwnd() {
                    unsafe {
                        DwmExtendFrameIntoClientArea(
                            handle.0,
                            &MARGINS {
                                cxLeftWidth: -1,
                                ..Default::default()
                            },
                        );
                    }
                }
            }
            return true;
        }
        let _ = window_vibrancy::clear_mica(window);
        // Keep the caption aligned without pinning the WebView's system theme.
        if let Ok(handle) = window.hwnd() {
            let dark = i32::from(dark);
            unsafe {
                DwmSetWindowAttribute(
                    handle.0,
                    DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
                    (&dark as *const i32).cast(),
                    std::mem::size_of::<i32>() as u32,
                );
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let workspace = objc2_app_kit::NSWorkspace::sharedWorkspace();
        // window-vibrancy 0.6 inserts a fresh NSVisualEffectView on each apply;
        // focus/theme updates must replace the old view rather than stack them.
        let _ = window_vibrancy::clear_vibrancy(window);
        if enabled
            && !workspace.accessibilityDisplayShouldReduceTransparency()
            && !workspace.accessibilityDisplayShouldIncreaseContrast()
        {
            return window_vibrancy::apply_vibrancy(
                window,
                window_vibrancy::NSVisualEffectMaterial::Sidebar,
                None,
                None,
            )
            .is_ok();
        }
    }
    #[cfg(target_os = "linux")]
    let _ = (window, enabled);
    false
}
