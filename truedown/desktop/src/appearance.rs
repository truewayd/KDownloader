use tauri::WebviewWindow;

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
    #[cfg(not(windows))]
    let _ = dark;
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_USE_IMMERSIVE_DARK_MODE},
            UI::{
                Accessibility::{HCF_HIGHCONTRASTON, HIGHCONTRASTW},
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
            && window_vibrancy::apply_mica(&window, Some(dark)).is_ok()
        {
            return true;
        }
        let _ = window_vibrancy::clear_mica(&window);
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
        let _ = window_vibrancy::clear_vibrancy(&window);
        if enabled
            && !workspace.accessibilityDisplayShouldReduceTransparency()
            && !workspace.accessibilityDisplayShouldIncreaseContrast()
        {
            return window_vibrancy::apply_vibrancy(
                &window,
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
