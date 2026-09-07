use tauri::image::Image;

const ICO: &[u8] = include_bytes!("../../windows/truedown.ico");

// Decode the matching raster, instead of decoding one ICO frame and letting
// Explorer enlarge it. The source contains 16/20/24/32/40/48/64/128/256 pixels.
pub fn image_for_pixels(pixels: u32) -> Result<Image<'static>, String> {
    let count = u16::from_le_bytes(ICO[4..6].try_into().unwrap()) as usize;
    let mut best = None;
    for entry in ICO[6..6 + count * 16].as_chunks::<16>().0 {
        let width = if entry[0] == 0 {
            256
        } else {
            u32::from(entry[0])
        };
        let distance = width.abs_diff(pixels);
        if best.is_none_or(|(previous, _, _)| distance < previous) {
            let length = u32::from_le_bytes(entry[8..12].try_into().unwrap()) as usize;
            let offset = u32::from_le_bytes(entry[12..16].try_into().unwrap()) as usize;
            best = Some((distance, offset, length));
        }
    }
    let (_, offset, length) = best.ok_or("Tray icon contains no images")?;
    Image::from_bytes(
        ICO.get(offset..offset + length)
            .ok_or("Invalid tray raster")?,
    )
    .map_err(|error| error.to_string())
}

pub fn track(tray: tauri::tray::TrayIcon) {
    #[cfg(windows)]
    tauri::async_runtime::spawn(async move {
        let mut previous = 0;
        loop {
            if let Some(pixels) = tray_pixels(&tray) {
                if pixels != previous {
                    if let Ok(image) = image_for_pixels(pixels) {
                        if tray.set_icon(Some(image)).is_ok() {
                            previous = pixels;
                        }
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    });
    #[cfg(target_os = "macos")]
    {
        let _ = tray.set_icon_as_template(true);
    }
    #[cfg(target_os = "linux")]
    let _ = tray;
}

#[cfg(windows)]
fn tray_pixels(tray: &tauri::tray::TrayIcon) -> Option<u32> {
    use windows_sys::Win32::{
        Foundation::RECT,
        Graphics::Gdi::{MonitorFromRect, MONITOR_DEFAULTTONEAREST},
        UI::{
            HiDpi::{GetDpiForMonitor, GetSystemMetricsForDpi, MDT_EFFECTIVE_DPI},
            WindowsAndMessaging::SM_CXSMICON,
        },
    };
    let rect = tray.rect().ok()??;
    let origin = rect.position.to_physical::<i32>(1.0);
    let size = rect.size.to_physical::<i32>(1.0);
    let area = RECT {
        left: origin.x,
        top: origin.y,
        right: origin.x + size.width,
        bottom: origin.y + size.height,
    };
    let mut x = 96;
    let mut y = 96;
    unsafe {
        let monitor = MonitorFromRect(&area, MONITOR_DEFAULTTONEAREST);
        if GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut x, &mut y) < 0 {
            return None;
        }
        Some(GetSystemMetricsForDpi(SM_CXSMICON, x).clamp(16, 256) as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn high_dpi_icons_have_exact_physical_dimensions() {
        for pixels in [16, 20, 24, 32, 40, 48, 64, 128, 256] {
            let icon = image_for_pixels(pixels).unwrap();
            assert_eq!((icon.width(), icon.height()), (pixels, pixels));
            assert_eq!(icon.rgba().len(), (pixels * pixels * 4) as usize);
            assert!(icon
                .rgba()
                .as_chunks::<4>()
                .0
                .iter()
                .any(|pixel| pixel[3] > 0));
        }
    }
}
