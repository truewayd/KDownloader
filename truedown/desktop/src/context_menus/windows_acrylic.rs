//! Acrylic is a compositor backdrop under an alpha-preserving GDI surface.
use super::*;
use windows_sys::Win32::UI::Controls::MARGINS;

pub(super) unsafe fn configure(style: &Style, popup: HWND) {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let transparency = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize")
        .ok()
        .and_then(|key| key.get_value::<u32, _>("EnableTransparency").ok())
        .unwrap_or(1)
        != 0;
    let mut contrast = HIGHCONTRASTW {
        cbSize: std::mem::size_of::<HIGHCONTRASTW>() as u32,
        ..Default::default()
    };
    let allowed = transparency
        && SystemParametersInfoW(
            SPI_GETHIGHCONTRAST,
            contrast.cbSize,
            (&mut contrast as *mut HIGHCONTRASTW).cast(),
            0,
        ) != 0
        && contrast.dwFlags & HCF_HIGHCONTRASTON == 0;
    let backdrop = DWMSBT_TRANSIENTWINDOW;
    let enabled = allowed
        && DwmSetWindowAttribute(
            popup,
            DWMWA_SYSTEMBACKDROP_TYPE as u32,
            (&backdrop as *const DWM_SYSTEMBACKDROP_TYPE).cast(),
            std::mem::size_of_val(&backdrop) as u32,
        ) >= 0
        && DwmExtendFrameIntoClientArea(
            popup,
            &MARGINS {
                cxLeftWidth: -1,
                cxRightWidth: -1,
                cyTopHeight: -1,
                cyBottomHeight: -1,
            },
        ) >= 0;
    if !enabled {
        let none = DWMSBT_NONE;
        DwmSetWindowAttribute(
            popup,
            DWMWA_SYSTEMBACKDROP_TYPE as u32,
            (&none as *const DWM_SYSTEMBACKDROP_TYPE).cast(),
            std::mem::size_of_val(&none) as u32,
        );
        DwmExtendFrameIntoClientArea(popup, &MARGINS::default());
    }
    style.acrylic.set(enabled);
    // GDI black initializes transparent, zero-alpha pixels under extended glass.
    // Content below explicitly writes premultiplied alpha, including glyphs.
    let info = MENUINFO {
        cbSize: std::mem::size_of::<MENUINFO>() as u32,
        fMask: MIM_BACKGROUND,
        hbrBack: if enabled {
            GetStockObject(BLACK_BRUSH)
        } else {
            style.surface
        },
        ..Default::default()
    };
    SetMenuInfo(style.menu, &info);
}

struct Buffer {
    dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    pixels: *mut u8,
}
impl Buffer {
    unsafe fn new(target: HDC, width: i32, height: i32) -> Option<Self> {
        if !(1..=4096).contains(&width) || !(1..=1024).contains(&height) {
            return None;
        }
        let dc = CreateCompatibleDC(target);
        if dc.is_null() {
            return None;
        }
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = std::ptr::null_mut();
        let bitmap = CreateDIBSection(
            dc,
            &info,
            DIB_RGB_COLORS,
            &mut pixels,
            std::ptr::null_mut(),
            0,
        );
        if bitmap.is_null() {
            DeleteDC(dc);
            return None;
        }
        let previous = SelectObject(dc, bitmap);
        if previous.is_null() || previous as isize == -1 {
            DeleteObject(bitmap);
            DeleteDC(dc);
            return None;
        }
        Some(Self {
            dc,
            bitmap,
            previous,
            pixels: pixels.cast(),
        })
    }
}

pub(super) unsafe fn disable(style: &Style, popup: HWND) {
    let none = DWMSBT_NONE;
    DwmSetWindowAttribute(
        popup,
        DWMWA_SYSTEMBACKDROP_TYPE as u32,
        (&none as *const DWM_SYSTEMBACKDROP_TYPE).cast(),
        std::mem::size_of_val(&none) as u32,
    );
    DwmExtendFrameIntoClientArea(popup, &MARGINS::default());
    style.acrylic.set(false);
    let info = MENUINFO {
        cbSize: std::mem::size_of::<MENUINFO>() as u32,
        fMask: MIM_BACKGROUND,
        hbrBack: style.surface,
        ..Default::default()
    };
    SetMenuInfo(style.menu, &info);
    InvalidateRect(popup, std::ptr::null(), 1);
}
impl Drop for Buffer {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.previous);
            DeleteObject(self.bitmap);
            DeleteDC(self.dc);
        }
    }
}

pub(super) unsafe fn draw_item(style: &Style, item: &Item, draw: &DRAWITEMSTRUCT) -> bool {
    let width = draw.rcItem.right - draw.rcItem.left;
    let height = draw.rcItem.bottom - draw.rcItem.top;
    let Some(buffer) = Buffer::new(draw.hDC, width, height) else {
        return false;
    };
    let rect = RECT {
        left: 0,
        top: 0,
        right: width,
        bottom: height,
    };
    super::draw_content(
        style,
        item,
        &DRAWITEMSTRUCT {
            hDC: buffer.dc,
            rcItem: rect,
            ..Default::default()
        },
        true,
    );
    let old_font = SelectObject(buffer.dc, style.font);
    let mut shortcut = SIZE::default();
    if !item.shortcut.is_empty() {
        GetTextExtentPoint32W(
            buffer.dc,
            item.shortcut.as_ptr(),
            item.shortcut.len() as i32,
            &mut shortcut,
        );
    }
    SelectObject(buffer.dc, old_font);
    GdiFlush(); // Complete queued mask drawing before accessing DIB memory.
    let pixels =
        std::slice::from_raw_parts_mut(buffer.pixels, width as usize * height as usize * 4);
    let selected = draw.itemState & ODS_SELECTED != 0;
    let dark = style.palette.surface == Palette::new(true).surface;
    let shortcut_start = width - px(style.dpi, 12) - shortcut.cx;
    let text = if item.danger {
        style.palette.danger
    } else {
        style.palette.text
    };
    for (index, pixel) in pixels.chunks_exact_mut(4).enumerate() {
        let x = (index % width as usize) as i32;
        let y = (index / width as usize) as i32;
        let coverage = u32::from(pixel[0].max(pixel[1]).max(pixel[2]));
        let foreground = if shortcut.cx > 0 && x >= shortcut_start {
            style.palette.muted
        } else {
            text
        };
        let hover = if selected {
            hover_alpha(x, y, width, height, style.dpi)
        } else {
            0
        };
        let under = hover * (255 - coverage) / 255;
        let alpha = coverage + under;
        let overlay = if dark { 255 } else { 0 };
        for (channel, shift) in [16, 8, 0].into_iter().enumerate() {
            pixel[channel] =
                ((((foreground >> shift) & 255) * coverage + overlay * under + 127) / 255) as u8;
        }
        pixel[3] = alpha as u8;
    }
    BitBlt(
        draw.hDC,
        draw.rcItem.left,
        draw.rcItem.top,
        width,
        height,
        buffer.dc,
        0,
        0,
        SRCCOPY,
    ) != 0
}

fn hover_alpha(x: i32, y: i32, width: i32, height: i32, dpi: u32) -> u32 {
    let half_x = width as f64 / 2.0 - px(dpi, 4) as f64;
    let half_y = height as f64 / 2.0 - px(dpi, 2) as f64;
    let radius = (px(dpi, 6) as f64).min(half_x).min(half_y).max(0.0);
    let dx = (x as f64 + 0.5 - width as f64 / 2.0).abs() - half_x + radius;
    let dy = (y as f64 + 0.5 - height as f64 / 2.0).abs() - half_y + radius;
    let distance = dx.max(0.0).hypot(dy.max(0.0)) + dx.max(dy).min(0.0) - radius;
    ((0.5 - distance).clamp(0.0, 1.0) * 28.0).round() as u32
}
