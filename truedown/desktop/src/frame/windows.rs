//! Extend the client into the caption while keeping DWM's real caption buttons.
//! The WebView region excludes those buttons, so its child HWND cannot obscure
//! their painting or consume their non-client mouse input (including Snap).
use std::ptr::null_mut;
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
    Graphics::{
        Dwm::{DwmDefWindowProc, DwmExtendFrameIntoClientArea},
        Gdi::{
            BeginPaint, CombineRgn, CreateRectRgn, DeleteObject, EndPaint, FillRect,
            GetStockObject, InvalidateRect, ScreenToClient, SetWindowRgn, BLACK_BRUSH, HDC,
            PAINTSTRUCT, RGN_DIFF,
        },
    },
    UI::{
        Controls::MARGINS,
        HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi},
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::*,
    },
};

const SUBCLASS: usize = 0x54444652;
pub const BUTTON_WIDTH: f64 = 144.0;
pub const CAPTION_HEIGHT: f64 = 40.0;

unsafe fn caption_hit(hwnd: HWND, point: &POINT) -> Option<LRESULT> {
    // DWM does not hit-test hidden windows. The OS accessibility rectangles
    // still describe its real controls, and also cover transient DWM refreshes.
    let mut info = TITLEBARINFOEX {
        cbSize: std::mem::size_of::<TITLEBARINFOEX>() as u32,
        ..Default::default()
    };
    SendMessageW(
        hwnd,
        WM_GETTITLEBARINFOEX,
        0,
        (&mut info as *mut TITLEBARINFOEX) as LPARAM,
    );
    for (index, hit) in [(2, HTMINBUTTON), (3, HTMAXBUTTON), (5, HTCLOSE)] {
        let rect = info.rgrect[index];
        if point.x >= rect.left
            && point.x < rect.right
            && point.y >= rect.top
            && point.y < rect.bottom
        {
            return Some(hit as LRESULT);
        }
    }
    None
}

unsafe fn pixels(hwnd: HWND, logical: f64) -> i32 {
    (logical * GetDpiForWindow(hwnd).max(96) as f64 / 96.0).ceil() as i32
}

unsafe fn webview(hwnd: HWND) -> HWND {
    let class: Vec<u16> = "WRY_WEBVIEW\0".encode_utf16().collect();
    FindWindowExW(hwnd, null_mut(), class.as_ptr(), std::ptr::null())
}

unsafe fn paint_caption(hwnd: HWND, dc: HDC) {
    let mut rect = RECT::default();
    if GetClientRect(hwnd, &mut rect) != 0 {
        rect.bottom = pixels(hwnd, CAPTION_HEIGHT).min(rect.bottom);
        // A clipped WebView alone does not initialize its parent's surface.
        // DWM requires zero-alpha pixels underneath the extended native frame.
        FillRect(dc, &rect, GetStockObject(BLACK_BRUSH));
    }
}

unsafe fn refresh(hwnd: HWND) {
    let top = pixels(hwnd, CAPTION_HEIGHT);
    DwmExtendFrameIntoClientArea(
        hwnd,
        &MARGINS {
            cyTopHeight: top,
            ..Default::default()
        },
    );
    let child = webview(hwnd);
    let mut rect = RECT::default();
    if child.is_null() || GetClientRect(child, &mut rect) == 0 {
        return;
    }
    // Windows owns the resize border above the WebView too. Keep the regular
    // left/right/bottom non-client frame, and restore the top resize hit area.
    let edge = if IsZoomed(hwnd) == 0 {
        pixels(hwnd, 4.0)
    } else {
        0
    };
    let region = CreateRectRgn(0, edge, rect.right, rect.bottom);
    let buttons = CreateRectRgn(
        (rect.right - pixels(hwnd, BUTTON_WIDTH)).max(0),
        0,
        rect.right,
        top,
    );
    if !region.is_null() && !buttons.is_null() && CombineRgn(region, region, buttons, RGN_DIFF) != 0
    {
        // Ownership transfers only after a successful SetWindowRgn call.
        if SetWindowRgn(child, region, 1) == 0 {
            DeleteObject(region);
        }
    } else if !region.is_null() {
        DeleteObject(region);
    }
    if !buttons.is_null() {
        DeleteObject(buttons);
    }
    // Refresh exposed parent pixels after resize, activation and theme changes.
    rect.bottom = top.min(rect.bottom);
    InvalidateRect(hwnd, &rect, 1);
}

unsafe extern "system" fn procedure(
    hwnd: HWND,
    message: u32,
    wp: WPARAM,
    lp: LPARAM,
    _: usize,
    _: usize,
) -> LRESULT {
    if message == WM_ERASEBKGND || message == WM_PRINTCLIENT {
        paint_caption(hwnd, wp as HDC);
        return 1;
    }
    if message == WM_PAINT {
        let mut paint = PAINTSTRUCT::default();
        let dc = BeginPaint(hwnd, &mut paint);
        paint_caption(hwnd, dc);
        EndPaint(hwnd, &paint);
        return DefSubclassProc(hwnd, message, wp, lp);
    }
    if message == WM_NCCALCSIZE && wp != 0 {
        let params = &mut *(lp as *mut NCCALCSIZE_PARAMS);
        let top = params.rgrc[0].top;
        // Let the OS calculate side/bottom borders and maximized work-area
        // insets. Replace only the caption inset; do not erase WS_CAPTION.
        DefSubclassProc(hwnd, message, wp, lp);
        let dpi = GetDpiForWindow(hwnd).max(96);
        params.rgrc[0].top = top
            + if IsZoomed(hwnd) != 0 {
                GetSystemMetricsForDpi(SM_CYFRAME, dpi)
                    + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi)
            } else {
                1
            };
        return 0;
    }
    // Include WM_NCMOUSELEAVE so DWM clears hover highlighting correctly.
    let mut result = 0;
    if DwmDefWindowProc(hwnd, message, wp, lp, &mut result) != 0 {
        return result;
    }
    if message == WM_NCHITTEST {
        let mut point = POINT {
            x: lp as i16 as i32,
            y: (lp >> 16) as i16 as i32,
        };
        if let Some(hit) = caption_hit(hwnd, &point) {
            return hit;
        }
        ScreenToClient(hwnd, &mut point);
        if IsZoomed(hwnd) == 0 && point.y >= 0 && point.y < pixels(hwnd, 4.0) {
            let mut bounds = RECT::default();
            GetClientRect(hwnd, &mut bounds);
            if point.x < pixels(hwnd, 8.0) {
                return HTTOPLEFT as LRESULT;
            }
            if point.x >= bounds.right - pixels(hwnd, 8.0) {
                return HTTOPRIGHT as LRESULT;
            }
            return HTTOP as LRESULT;
        }
    }
    if message == WM_NCDESTROY {
        RemoveWindowSubclass(hwnd, Some(procedure), SUBCLASS);
    }
    let result = DefSubclassProc(hwnd, message, wp, lp);
    if matches!(
        message,
        WM_SIZE
            | WM_DPICHANGED
            | WM_DWMCOMPOSITIONCHANGED
            | WM_THEMECHANGED
            | WM_SHOWWINDOW
            | WM_ACTIVATE
    ) {
        refresh(hwnd);
    }
    result
}

/// Must run on the HWND's owning UI thread, after the WebView is constructed.
pub unsafe fn install(hwnd: HWND) -> Result<(), String> {
    if webview(hwnd).is_null() {
        return Err("Native WebView host is unavailable".into());
    }
    if SetWindowSubclass(hwnd, Some(procedure), SUBCLASS, 0) == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    if SetWindowPos(
        hwnd,
        null_mut(),
        0,
        0,
        0,
        0,
        SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
    ) == 0
    {
        RemoveWindowSubclass(hwnd, Some(procedure), SUBCLASS);
        return Err(std::io::Error::last_os_error().to_string());
    }
    refresh(hwnd);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, GdiFlush, SelectObject, BITMAPINFO,
        BITMAPINFOHEADER, DIB_RGB_COLORS,
    };

    #[test]
    fn caption_paint_initializes_alpha_without_erasing_the_body() {
        unsafe {
            // Keep the whole check on one thread/process: GDI DC handles cannot
            // be passed to another process via an arbitrary window message.
            let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
            let hwnd = CreateWindowExW(
                0,
                class.as_ptr(),
                std::ptr::null(),
                WS_OVERLAPPEDWINDOW,
                0,
                0,
                640,
                480,
                null_mut(),
                null_mut(),
                null_mut(),
                std::ptr::null(),
            );
            assert!(!hwnd.is_null());
            assert_eq!(IsWindowVisible(hwnd), 0);
            let mut bounds = RECT::default();
            assert_ne!(GetClientRect(hwnd, &mut bounds), 0);
            let width = bounds.right;
            let height = bounds.bottom;
            let dc = CreateCompatibleDC(null_mut());
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height,
                    biPlanes: 1,
                    biBitCount: 32,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits = null_mut();
            let bitmap = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &mut bits, null_mut(), 0);
            assert!(!dc.is_null() && !bitmap.is_null() && !bits.is_null());
            let previous = SelectObject(dc, bitmap);
            let pixels =
                std::slice::from_raw_parts_mut(bits.cast::<u32>(), (width * height) as usize);
            pixels.fill(0x7f11aacc);
            assert_ne!(SetWindowSubclass(hwnd, Some(procedure), SUBCLASS, 0), 0);
            for message in [WM_ERASEBKGND, WM_PRINTCLIENT] {
                pixels.fill(0x7f11aacc);
                assert_eq!(SendMessageW(hwnd, message, dc as WPARAM, 0), 1);
                GdiFlush();
                let caption_height = super::pixels(hwnd, CAPTION_HEIGHT).min(height) as usize;
                let split = width as usize * caption_height;
                assert!(
                    pixels[..split].iter().all(|pixel| *pixel == 0),
                    "DWM caption backing must have zero RGB and alpha"
                );
                assert!(
                    pixels[split..].iter().all(|pixel| *pixel == 0x7f11aacc),
                    "Caption painting must not clear the working surface"
                );
            }
            RemoveWindowSubclass(hwnd, Some(procedure), SUBCLASS);
            SelectObject(dc, previous);
            DeleteObject(bitmap);
            DeleteDC(dc);
            DestroyWindow(hwnd);
        }
    }
}
