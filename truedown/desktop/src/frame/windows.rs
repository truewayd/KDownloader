//! Extend the client into the caption while keeping DWM's real caption buttons.
//! The WebView region excludes those buttons, so its child HWND cannot obscure
//! their painting or consume their non-client mouse input (including Snap).
use std::ptr::null_mut;
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
    Graphics::{
        Dwm::{DwmDefWindowProc, DwmExtendFrameIntoClientArea},
        Gdi::{CombineRgn, CreateRectRgn, DeleteObject, ScreenToClient, SetWindowRgn, RGN_DIFF},
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
}

unsafe extern "system" fn procedure(
    hwnd: HWND,
    message: u32,
    wp: WPARAM,
    lp: LPARAM,
    _: usize,
    _: usize,
) -> LRESULT {
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
        WM_SIZE | WM_DPICHANGED | WM_DWMCOMPOSITIONCHANGED | WM_THEMECHANGED | WM_SHOWWINDOW
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
