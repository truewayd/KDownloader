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
pub fn apply_material(window: WebviewWindow, enabled: bool) -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::{
            Accessibility::{HCF_HIGHCONTRASTON, HIGHCONTRASTW},
            WindowsAndMessaging::{SystemParametersInfoW, SPI_GETHIGHCONTRAST},
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
        unsafe {
            SystemParametersInfoW(
                SPI_GETHIGHCONTRAST,
                contrast.cbSize,
                (&mut contrast as *mut HIGHCONTRASTW).cast(),
                0,
            );
        }
        if enabled && transparent && contrast.dwFlags & HCF_HIGHCONTRASTON == 0 {
            return window_vibrancy::apply_mica(&window, None).is_ok();
        }
        let _ = window_vibrancy::clear_mica(&window);
    }
    #[cfg(target_os = "macos")]
    {
        if enabled {
            return window_vibrancy::apply_vibrancy(
                &window,
                window_vibrancy::NSVisualEffectMaterial::Sidebar,
                None,
                None,
            )
            .is_ok();
        }
        let _ = window_vibrancy::clear_vibrancy(&window);
    }
    #[cfg(target_os = "linux")]
    let _ = (window, enabled);
    false
}
