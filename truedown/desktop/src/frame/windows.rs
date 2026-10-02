//! Extend the client into the caption while keeping DWM's real caption buttons.
//! The WebView region excludes those buttons, so its child HWND cannot obscure
//! their painting or consume their non-client mouse input (including Snap).
//! An active DOM tooltip can reveal its bounded, rounded footprint temporarily.
use std::ptr::null_mut;
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
    Graphics::{
        Dwm::{DwmDefWindowProc, DwmExtendFrameIntoClientArea},
        Gdi::{
            BeginPaint, CombineRgn, CreateRectRgn, CreateRoundRectRgn, DeleteObject, EndPaint,
            FillRect, GetStockObject, InvalidateRect, ScreenToClient, SetWindowRgn, BLACK_BRUSH,
            HDC, HRGN, PAINTSTRUCT, RGN_AND, RGN_DIFF, RGN_OR,
        },
    },
    UI::{
        Controls::MARGINS,
        HiDpi::{AdjustWindowRectExForDpi, GetDpiForWindow, GetSystemMetricsForDpi},
        Shell::{DefSubclassProc, GetWindowSubclass, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::*,
    },
};

const SUBCLASS: usize = 0x54444652;
pub const BUTTON_WIDTH: f64 = 144.0;
pub const CAPTION_HEIGHT: f64 = 40.0;

#[derive(Default)]
struct Tooltip {
    session: u32,
    revision: u32,
    bounds: Option<super::TooltipBounds>,
}

unsafe fn tooltip_state(hwnd: HWND) -> Option<&'static mut Tooltip> {
    let mut data = 0;
    if GetWindowSubclass(hwnd, Some(procedure), SUBCLASS, &mut data) == 0 || data == 0 {
        None
    } else {
        Some(&mut *(data as *mut Tooltip))
    }
}

pub unsafe fn tooltip(
    hwnd: HWND,
    session: u32,
    revision: u32,
    bounds: Option<super::TooltipBounds>,
) -> Result<u32, String> {
    let state = tooltip_state(hwnd).ok_or("Native frame unavailable")?;
    if session == 0 {
        state.session = state
            .session
            .checked_add(1)
            .ok_or("Tooltip session exhausted")?;
        state.revision = 0;
        state.bounds = None;
    } else if state.session == session && revision > state.revision {
        state.revision = revision;
        state.bounds =
            bounds.filter(|_| IsWindowVisible(hwnd) != 0 && GetForegroundWindow() == hwnd);
    }
    let current = state.session;
    refresh(hwnd);
    Ok(current)
}

unsafe fn tooltip_region(bounds: super::TooltipBounds, rect: &RECT) -> HRGN {
    // CSS viewport ratios include WebView zoom as well as monitor DPI.
    let scale = rect.right as f64 / bounds.viewport_width;
    if !bounds.valid()
        || !(0.25..=8.0).contains(&scale)
        || (bounds.viewport_height * scale - rect.bottom as f64).abs() > 2.0
    {
        return null_mut();
    }
    let radius = (bounds.radius * scale * 2.0).round() as i32;
    CreateRoundRectRgn(
        (bounds.left * scale).floor() as i32,
        (bounds.top * scale).floor() as i32,
        ((bounds.left + bounds.width) * scale).ceil() as i32 + 1,
        ((bounds.top + bounds.height) * scale).ceil() as i32 + 1,
        radius,
        radius,
    )
}

pub unsafe fn sizing_offset(hwnd: HWND) -> Result<(f64, f64), String> {
    let mut inner = RECT::default();
    let mut outer = RECT::default();
    if GetClientRect(hwnd, &mut inner) == 0 || GetWindowRect(hwnd, &mut outer) == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let mut standard = inner;
    let dpi = GetDpiForWindow(hwnd).max(96);
    if AdjustWindowRectExForDpi(
        &mut standard,
        GetWindowLongW(hwnd, GWL_STYLE) as u32,
        (!GetMenu(hwnd).is_null()) as i32,
        GetWindowLongW(hwnd, GWL_EXSTYLE) as u32,
        dpi,
    ) == 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let scale = dpi as f64 / 96.0;
    Ok((
        ((standard.right - standard.left) - (outer.right - outer.left)) as f64 / scale,
        ((standard.bottom - standard.top) - (outer.bottom - outer.top)) as f64 / scale,
    ))
}

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
            // Extend only the native caption. Full-sheet glass also changes
            // DWM's caption composition; the Mica backdrop is owned separately
            // by appearance.rs, not by this frame's margins.
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
    let edge = if IsZoomed(hwnd) == 0 && GetWindowLongW(hwnd, GWL_STYLE) as u32 & WS_THICKFRAME != 0
    {
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
        if let Some(bounds) = tooltip_state(hwnd).and_then(|state| state.bounds) {
            let tip = tooltip_region(bounds, &rect);
            if !tip.is_null() {
                // Reveal only the caption intersection, preserving resize borders.
                let allowed = CreateRectRgn(0, edge, rect.right, rect.bottom);
                if !allowed.is_null() {
                    CombineRgn(tip, tip, allowed, RGN_AND);
                    CombineRgn(region, region, tip, RGN_OR);
                    DeleteObject(allowed);
                }
                DeleteObject(tip);
            }
        }
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
    data: usize,
) -> LRESULT {
    if matches!(
        message,
        WM_SIZE
            | WM_MOVE
            | WM_DPICHANGED
            | WM_SHOWWINDOW
            | WM_ACTIVATE
            | WM_CANCELMODE
            | WM_ENTERSIZEMOVE
    ) {
        if let Some(state) = tooltip_state(hwnd) {
            state.bounds = None;
        }
    }
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
                // DWM needs a fully extended top edge to draw its caption
                // controls. Even a one-pixel inset suppresses them on Win11.
                0
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
        if IsZoomed(hwnd) == 0
            && GetWindowLongW(hwnd, GWL_STYLE) as u32 & WS_THICKFRAME != 0
            && point.y >= 0
            && point.y < pixels(hwnd, 4.0)
        {
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
        // The large icon borrows Tao's small-icon handle until window teardown.
        SendMessageW(hwnd, WM_SETICON, ICON_BIG as WPARAM, 0);
        RemoveWindowSubclass(hwnd, Some(procedure), SUBCLASS);
        if data != 0 {
            drop(Box::from_raw(data as *mut Tooltip));
        }
        return DefSubclassProc(hwnd, message, wp, lp);
    }
    let result = DefSubclassProc(hwnd, message, wp, lp);
    if matches!(
        message,
        WM_SIZE
            | WM_MOVE
            | WM_DPICHANGED
            | WM_DWMCOMPOSITIONCHANGED
            | WM_THEMECHANGED
            | WM_SHOWWINDOW
            | WM_ACTIVATE
            | WM_CANCELMODE
            | WM_ENTERSIZEMOVE
    ) {
        refresh(hwnd);
    }
    result
}

/// Must run on the HWND's owning UI thread, after the WebView is constructed.
pub unsafe fn install(hwnd: HWND) -> Result<(), String> {
    let mut existing = 0usize;
    if GetWindowSubclass(hwnd, Some(procedure), SUBCLASS, &mut existing) != 0 {
        return Ok(());
    }
    if webview(hwnd).is_null() {
        return Err("Native WebView host is unavailable".into());
    }
    let state = Box::into_raw(Box::<Tooltip>::default());
    if SetWindowSubclass(hwnd, Some(procedure), SUBCLASS, state as usize) == 0 {
        drop(Box::from_raw(state));
        return Err(std::io::Error::last_os_error().to_string());
    }
    // Tauri supplies ICON_SMALL only. Give the taskbar the same role-specific
    // full-resolution image; Tao owns this handle for the window's lifetime.
    let icon = SendMessageW(hwnd, WM_GETICON, ICON_SMALL as WPARAM, 0);
    if icon != 0 {
        SendMessageW(hwnd, WM_SETICON, ICON_BIG as WPARAM, icon);
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
        drop(Box::from_raw(state));
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
    fn tooltip_reveal_is_rounded_and_tracks_viewport_scale() {
        use windows_sys::Win32::Graphics::Gdi::PtInRegion;
        unsafe {
            for scale in [1.0, 1.25, 1.5, 2.0] {
                let viewport = RECT {
                    right: (800.0 * scale) as i32,
                    bottom: (600.0 * scale) as i32,
                    ..Default::default()
                };
                let bounds = super::super::TooltipBounds {
                    left: 600.0,
                    top: 12.0,
                    width: 192.0,
                    height: 38.0,
                    radius: 12.0,
                    viewport_width: 800.0,
                    viewport_height: 600.0,
                };
                let region = tooltip_region(bounds, &viewport);
                assert!(!region.is_null());
                assert_ne!(
                    PtInRegion(region, (700.0 * scale) as i32, (25.0 * scale) as i32),
                    0
                );
                assert_eq!(
                    PtInRegion(region, (600.0 * scale) as i32, (12.0 * scale) as i32),
                    0
                );
                assert_eq!(
                    PtInRegion(region, (799.0 * scale) as i32, (25.0 * scale) as i32),
                    0
                );
                DeleteObject(region);
                assert!(tooltip_region(
                    super::super::TooltipBounds {
                        viewport_height: 800.0,
                        ..bounds
                    },
                    &viewport
                )
                .is_null());
            }
        }
    }

    #[test]
    fn extended_caption_sizes_fit_small_work_areas_without_repeated_growth() {
        unsafe {
            let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
            let hwnd = CreateWindowExW(
                0,
                class.as_ptr(),
                std::ptr::null(),
                WS_OVERLAPPEDWINDOW,
                0,
                0,
                976,
                800,
                null_mut(),
                null_mut(),
                null_mut(),
                std::ptr::null(),
            );
            assert!(!hwnd.is_null());
            struct HiddenWindow(HWND);
            impl Drop for HiddenWindow {
                fn drop(&mut self) {
                    unsafe { DestroyWindow(self.0) };
                }
            }
            let _window = HiddenWindow(hwnd);
            assert_ne!(SetWindowSubclass(hwnd, Some(procedure), SUBCLASS, 0), 0);
            assert_ne!(
                SetWindowPos(
                    hwnd,
                    null_mut(),
                    0,
                    0,
                    976,
                    800,
                    SWP_FRAMECHANGED | SWP_NOZORDER | SWP_NOACTIVATE
                ),
                0
            );
            let dpi = GetDpiForWindow(hwnd).max(96);
            let scale = dpi as f64 / 96.0;
            let resize = |width: i32, height: i32| {
                // Exercise the same standard-frame conversion used by Tao.
                let mut rect = RECT {
                    right: width,
                    bottom: height,
                    ..Default::default()
                };
                assert_ne!(
                    AdjustWindowRectExForDpi(
                        &mut rect,
                        GetWindowLongW(hwnd, GWL_STYLE) as u32,
                        0,
                        GetWindowLongW(hwnd, GWL_EXSTYLE) as u32,
                        dpi
                    ),
                    0
                );
                assert_ne!(
                    SetWindowPos(
                        hwnd,
                        null_mut(),
                        0,
                        0,
                        rect.right - rect.left,
                        rect.bottom - rect.top,
                        SWP_NOZORDER | SWP_NOACTIVATE
                    ),
                    0
                );
            };
            let bounds = || {
                let mut inner = RECT::default();
                let mut outer = RECT::default();
                assert_ne!(GetClientRect(hwnd, &mut inner), 0);
                assert_ne!(GetWindowRect(hwnd, &mut outer), 0);
                (inner, outer)
            };
            for (width, height) in [(1024, 720), (640, 360)] {
                let (inner, outer) = bounds();
                let client_width = width - ((outer.right - outer.left) - inner.right);
                let client_height = height - ((outer.bottom - outer.top) - inner.bottom);
                resize(client_width, client_height);
                let (_, overflow) = bounds();
                assert!(
                    overflow.bottom > height,
                    "Standard sizing must reproduce the old overflow"
                );
                for _ in 0..3 {
                    let offset = sizing_offset(hwnd).unwrap();
                    assert!(offset.1 > 0.0);
                    // set_min_inner_size re-applies the current client size.
                    let (current, _) = bounds();
                    resize(current.right, current.bottom);
                    resize(
                        client_width - (offset.0 * scale).round() as i32,
                        client_height - (offset.1 * scale).round() as i32,
                    );
                    let (actual, outer) = bounds();
                    assert_eq!((actual.right, actual.bottom), (client_width, client_height));
                    assert_eq!(
                        (outer.left, outer.top, outer.right, outer.bottom),
                        (0, 0, width, height)
                    );
                    assert_eq!(IsWindowVisible(hwnd), 0);
                }
            }
        }
    }

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
