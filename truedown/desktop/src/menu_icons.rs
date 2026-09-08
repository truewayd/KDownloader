use tauri::image::Image;

pub enum Icon {
    Download,
    Settings,
    Logs,
    Info,
    Power,
}

pub fn image(icon: Icon) -> tauri::Result<Image<'static>> {
    // macOS lays menu icons out at 16pt, preserving the 32px source for Retina.
    // Windows' menu backend consumes a 16px bitmap; render that size directly.
    let retina = cfg!(target_os = "macos");
    let bytes: &[u8] = match (icon, retina) {
        (Icon::Download, false) => include_bytes!("../icons/menu/download-16.png"),
        (Icon::Download, true) => include_bytes!("../icons/menu/download-32.png"),
        (Icon::Settings, false) => include_bytes!("../icons/menu/settings-16.png"),
        (Icon::Settings, true) => include_bytes!("../icons/menu/settings-32.png"),
        (Icon::Logs, false) => include_bytes!("../icons/menu/logs-16.png"),
        (Icon::Logs, true) => include_bytes!("../icons/menu/logs-32.png"),
        (Icon::Info, false) => include_bytes!("../icons/menu/info-16.png"),
        (Icon::Info, true) => include_bytes!("../icons/menu/info-32.png"),
        (Icon::Power, false) => include_bytes!("../icons/menu/power-16.png"),
        (Icon::Power, true) => include_bytes!("../icons/menu/power-32.png"),
    };
    Image::from_bytes(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_menu_icons_decode_at_the_platform_size() {
        let size = if cfg!(target_os = "macos") { 32 } else { 16 };
        for icon in [
            Icon::Download,
            Icon::Settings,
            Icon::Logs,
            Icon::Info,
            Icon::Power,
        ] {
            let image = image(icon).unwrap();
            assert_eq!((image.width(), image.height()), (size, size));
            assert!(image
                .rgba()
                .as_chunks::<4>()
                .0
                .iter()
                .any(|pixel| pixel[3] > 0));
        }
    }
}
