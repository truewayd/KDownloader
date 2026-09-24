//! Owner drawing changes pixels only; HMENU still owns input and accessibility.
use std::cell::Cell;
use tauri::image::Image;
use windows_sys::Win32::{
    Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM},
    Graphics::{Dwm::*, Gdi::*},
    UI::{
        Accessibility::{HCF_HIGHCONTRASTON, HIGHCONTRASTW},
        Controls::{DRAWITEMSTRUCT, MEASUREITEMSTRUCT, ODS_SELECTED, ODT_MENU},
        HiDpi::{GetDpiForWindow, SystemParametersInfoForDpi},
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::*,
    },
};

const SUBCLASS: usize = 0x54444d53;
const POPUP_SUBCLASS: usize = 0x54444d46;
thread_local! {
    static TRACKED_STYLE: Cell<*const Style> = const { Cell::new(std::ptr::null()) };
}
#[derive(Clone, Copy)]
struct Palette {
    surface: COLORREF,
    hover: COLORREF,
    text: COLORREF,
    muted: COLORREF,
    danger: COLORREF,
}
const fn rgb(r: u32, g: u32, b: u32) -> COLORREF {
    r | (g << 8) | (b << 16)
}
impl Palette {
    fn new(dark: bool) -> Self {
        if dark {
            Self {
                surface: rgb(43, 43, 43),
                hover: rgb(59, 59, 59),
                text: rgb(245, 245, 245),
                muted: rgb(188, 188, 188),
                danger: rgb(255, 153, 164),
            }
        } else {
            Self {
                surface: rgb(255, 255, 255),
                hover: rgb(240, 240, 240),
                text: rgb(32, 32, 32),
                muted: rgb(96, 96, 96),
                danger: rgb(196, 43, 28),
            }
        }
    }
}
struct Item {
    label: Vec<u16>,
    shortcut: Vec<u16>,
    icon: Image<'static>,
    danger: bool,
}
struct Style {
    popup: Cell<HWND>,
    shadow_class: Cell<Option<usize>>,
    shadow_suppressed: Cell<bool>,
    saw_popup: Cell<bool>,
    bound_popup: Cell<bool>,
    frame_paints: Cell<u32>,
    shadow_windows: Cell<u32>,
    corner_result: Cell<i32>,
    menu: HMENU,
    dpi: u32,
    width: u32,
    height: u32,
    palette: Palette,
    font: HFONT,
    surface: HBRUSH,
    hover: HBRUSH,
    items: Vec<Item>,
}
impl Drop for Style {
    fn drop(&mut self) {
        unsafe {
            DeleteObject(self.font);
            DeleteObject(self.surface);
            DeleteObject(self.hover);
        }
    }
}
pub struct Guard {
    hwnd: HWND,
    style: Box<Style>,
    attached: bool,
    hook: HHOOK,
}
impl Drop for Guard {
    fn drop(&mut self) {
        unsafe {
            if !self.hook.is_null() {
                UnhookWindowsHookEx(self.hook);
                TRACKED_STYLE.with(|slot| slot.set(std::ptr::null()));
            }
            log_frame(&self.style);
            detach_popup(&self.style);
            if self.attached {
                RemoveWindowSubclass(self.hwnd, Some(paint), SUBCLASS);
            }
            // The menu is destroyed next; release its reference to our brush first.
            let info = MENUINFO {
                cbSize: std::mem::size_of::<MENUINFO>() as u32,
                fMask: MIM_BACKGROUND,
                hbrBack: std::ptr::null_mut(),
                ..Default::default()
            };
            SetMenuInfo(self.style.menu, &info);
        }
    }
}
fn px(dpi: u32, logical: i32) -> i32 {
    ((logical as i64 * dpi as i64 + 48) / 96) as i32
}

pub unsafe fn attach(
    window: &tauri::WebviewWindow,
    menu: HMENU,
    actions: &[String],
) -> Result<Option<Guard>, String> {
    let mut contrast = HIGHCONTRASTW {
        cbSize: std::mem::size_of::<HIGHCONTRASTW>() as u32,
        ..Default::default()
    };
    if SystemParametersInfoW(
        SPI_GETHIGHCONTRAST,
        contrast.cbSize,
        (&mut contrast as *mut HIGHCONTRASTW).cast(),
        0,
    ) == 0
        || contrast.dwFlags & HCF_HIGHCONTRASTON != 0
    {
        return Ok(None);
    }
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
    let dpi = GetDpiForWindow(hwnd).max(96);
    let palette = Palette::new(window.theme().ok() == Some(tauri::Theme::Dark));
    let mut metrics = NONCLIENTMETRICSW {
        cbSize: std::mem::size_of::<NONCLIENTMETRICSW>() as u32,
        ..Default::default()
    };
    if SystemParametersInfoForDpi(
        SPI_GETNONCLIENTMETRICS,
        metrics.cbSize,
        (&mut metrics as *mut NONCLIENTMETRICSW).cast(),
        0,
        dpi,
    ) == 0
    {
        return Err("Menu font unavailable".into());
    }
    metrics.lfMenuFont.lfHeight = -metrics.lfMenuFont.lfHeight.abs().max(px(dpi, 13));
    let mut style = Box::new(Style {
        popup: Cell::new(std::ptr::null_mut()),
        shadow_class: Cell::new(None),
        shadow_suppressed: Cell::new(false),
        saw_popup: Cell::new(false),
        bound_popup: Cell::new(false),
        frame_paints: Cell::new(0),
        shadow_windows: Cell::new(0),
        corner_result: Cell::new(i32::MIN),
        menu,
        dpi,
        width: px(dpi, 240) as u32,
        height: px(dpi, 36).max(metrics.lfMenuFont.lfHeight.abs() + px(dpi, 16)) as u32,
        palette,
        font: CreateFontIndirectW(&metrics.lfMenuFont),
        surface: CreateSolidBrush(palette.surface),
        hover: CreateSolidBrush(palette.hover),
        items: Vec::with_capacity(actions.len()),
    });
    if style.font.is_null() || style.surface.is_null() || style.hover.is_null() {
        return Err("Menu drawing resources unavailable".into());
    }
    for action in actions {
        let (label, shortcut) = super::label(action)
            .ok_or("Unavailable menu action")?
            .split_once('\t')
            .unwrap_or((super::label(action).unwrap(), ""));
        style.items.push(Item {
            label: label.encode_utf16().collect(),
            shortcut: shortcut.encode_utf16().collect(),
            icon: icon(action, dpi > 96)?,
            danger: matches!(action.as_str(), "remove" | "clear-done"),
        });
    }
    let dc = GetDC(hwnd);
    if dc.is_null() {
        return Err("Menu measuring context unavailable".into());
    }
    let previous = SelectObject(dc, style.font);
    for item in &style.items {
        let mut label = SIZE::default();
        let mut shortcut = SIZE::default();
        GetTextExtentPoint32W(dc, item.label.as_ptr(), item.label.len() as i32, &mut label);
        if !item.shortcut.is_empty() {
            GetTextExtentPoint32W(
                dc,
                item.shortcut.as_ptr(),
                item.shortcut.len() as i32,
                &mut shortcut,
            );
        }
        style.width = style.width.max(
            (label.cx + shortcut.cx + px(dpi, if item.shortcut.is_empty() { 64 } else { 96 }))
                as u32,
        );
    }
    SelectObject(dc, previous);
    ReleaseDC(hwnd, dc);
    let mut guard = Guard {
        hwnd,
        style,
        attached: false,
        hook: std::ptr::null_mut(),
    };
    if SetWindowSubclass(
        hwnd,
        Some(paint),
        SUBCLASS,
        (&*guard.style as *const Style) as usize,
    ) == 0
    {
        return Err("Cannot install menu drawing".into());
    }
    guard.attached = true;
    let info = MENUINFO {
        cbSize: std::mem::size_of::<MENUINFO>() as u32,
        fMask: MIM_BACKGROUND,
        hbrBack: guard.style.surface,
        ..Default::default()
    };
    if SetMenuInfo(menu, &info) == 0 {
        return Err("Cannot style menu background".into());
    }
    for (index, item) in guard.style.items.iter().enumerate() {
        // Retain the original MIIM_STRING for screen readers and native menu queries.
        let info = MENUITEMINFOW {
            cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
            fMask: MIIM_FTYPE | MIIM_DATA,
            fType: MFT_OWNERDRAW,
            dwItemData: (item as *const Item) as usize,
            ..Default::default()
        };
        if SetMenuItemInfoW(menu, index as u32, 1, &info) == 0 {
            return Err("Cannot style menu item".into());
        }
    }
    if TRACKED_STYLE.with(|slot| !slot.get().is_null()) {
        return Err("Menu frame tracking is already active".into());
    }
    let thread = GetWindowThreadProcessId(hwnd, std::ptr::null_mut());
    if thread == 0 {
        return Err("Menu owner thread unavailable".into());
    }
    guard.hook = SetWindowsHookExW(
        WH_CALLWNDPROC,
        Some(before_popup_message),
        std::ptr::null_mut(),
        thread,
    );
    if guard.hook.is_null() {
        return Err("Cannot track native menu creation".into());
    }
    TRACKED_STYLE.with(|slot| slot.set(&*guard.style));
    Ok(Some(guard))
}

unsafe extern "system" fn before_popup_message(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code >= 0 && lp != 0 {
        let message = &*(lp as *const CWPSTRUCT);
        if message.message == WM_CREATE || message.message == WM_WINDOWPOSCHANGING {
            TRACKED_STYLE.with(|slot| {
                if let Some(style) = slot.get().as_ref() {
                    let mut class = [0u16; 32];
                    let len = GetClassNameW(message.hwnd, class.as_mut_ptr(), class.len() as i32);
                    let name = &class[..len.max(0) as usize];
                    if name == [35, 51, 50, 55, 54, 56] {
                        // #32768
                        style.saw_popup.set(true);
                        let mut info = MENUBARINFO {
                            cbSize: std::mem::size_of::<MENUBARINFO>() as u32,
                            ..Default::default()
                        };
                        // Bind only our HMENU, on its owning thread, before show.
                        // Buffered WM_DRAWITEM DCs need not belong to any HWND.
                        if GetMenuBarInfo(message.hwnd, OBJID_CLIENT, 0, &mut info) != 0
                            && info.hMenu == style.menu
                        {
                            frame(style, message.hwnd);
                        }
                    } else if message.message == WM_CREATE
                        && name == [83, 121, 115, 83, 104, 97, 100, 111, 119]
                    {
                        // SysShadow
                        style
                            .shadow_windows
                            .set(style.shadow_windows.get().saturating_add(1));
                    }
                }
            });
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, wp, lp)
}

fn log_frame(style: &Style) {
    #[cfg(debug_assertions)]
    {
        use std::io::Write;
        // Bounded local build diagnostics, with no menu labels or profile values.
        if let Ok(exe) = std::env::current_exe() {
            let path = exe.with_file_name("menu-frame-diagnostics.log");
            let large = std::fs::metadata(&path).is_ok_and(|meta| meta.len() > 65536);
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .append(!large)
                .truncate(large)
                .open(path)
            {
                let _ = writeln!(file,
                    "frame3 seen={} bound={} corner={} legacy_shadow_disabled={} frame_paints={} shadow_windows={}",
                    style.saw_popup.get(), style.bound_popup.get(), style.corner_result.get(),
                    style.shadow_suppressed.get(), style.frame_paints.get(), style.shadow_windows.get());
            }
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = style;
}

unsafe extern "system" fn paint(
    hwnd: HWND,
    message: u32,
    wp: WPARAM,
    lp: LPARAM,
    _: usize,
    data: usize,
) -> LRESULT {
    let style = &*(data as *const Style);
    if message == WM_MEASUREITEM && lp != 0 {
        let measure = &mut *(lp as *mut MEASUREITEMSTRUCT);
        if measure.CtlType == ODT_MENU
            && style
                .items
                .iter()
                .any(|item| (item as *const Item) as usize == measure.itemData)
        {
            measure.itemWidth = style.width;
            measure.itemHeight = style.height;
            return 1;
        }
    } else if message == WM_DRAWITEM && lp != 0 {
        let draw = &*(lp as *const DRAWITEMSTRUCT);
        if draw.CtlType == ODT_MENU && draw.hwndItem == style.menu {
            if let Some(item) = style
                .items
                .iter()
                .find(|item| (*item as *const Item) as usize == draw.itemData)
            {
                draw_item(style, item, draw);
                return 1;
            }
        }
    } else if message == WM_NCDESTROY {
        RemoveWindowSubclass(hwnd, Some(paint), SUBCLASS);
    }
    DefSubclassProc(hwnd, message, wp, lp)
}

// Called before show for the popup whose HMENU matches the active request.
// DWM owns clipping and shadows: regions/layered windows would disable its rounding.
// HMENU's GDI surface remains opaque; requesting Acrylic here would be misleading.
unsafe fn frame(style: &Style, popup: HWND) {
    if popup.is_null() || style.popup.get() == popup {
        return;
    }
    let mut class = [0u16; 32];
    let len = GetClassNameW(popup, class.as_mut_ptr(), class.len() as i32);
    if class[..len.max(0) as usize] != "#32768".encode_utf16().collect::<Vec<_>>() {
        return;
    }
    // DWM/subclass calls can send nested window messages through our hook.
    style.popup.set(popup);
    let corner = DWMWCP_ROUND;
    let corner_result = DwmSetWindowAttribute(
        popup,
        DWMWA_WINDOW_CORNER_PREFERENCE as u32,
        (&corner as *const DWM_WINDOW_CORNER_PREFERENCE).cast(),
        std::mem::size_of_val(&corner) as u32,
    );
    style.corner_result.set(corner_result);
    if corner_result < 0 {
        style.popup.set(std::ptr::null_mut());
        return; // Older Windows keeps the stock frame and shadow.
    }
    if SetWindowSubclass(
        popup,
        Some(popup_frame),
        POPUP_SUBCLASS,
        (style as *const Style) as usize,
    ) == 0
    {
        style.popup.set(std::ptr::null_mut());
        return;
    }
    style.popup.set(popup);
    style.bound_popup.set(true);
    // This must precede the first show: changing class flags after WM_DRAWITEM
    // cannot remove an already-created, separate SysShadow window.
    if IsWindowVisible(popup) == 0 {
        let original = GetClassLongPtrW(popup, GCL_STYLE);
        if original & CS_DROPSHADOW as usize != 0
            && SetClassLongPtrW(
                popup,
                GCL_STYLE,
                (original & !(CS_DROPSHADOW as usize)) as isize,
            ) != 0
        {
            style.shadow_class.set(Some(original));
            style.shadow_suppressed.set(true);
        }
    }
    let policy = DWMNCRP_ENABLED;
    DwmSetWindowAttribute(
        popup,
        DWMWA_NCRENDERING_POLICY as u32,
        (&policy as *const DWMNCRENDERINGPOLICY).cast(),
        std::mem::size_of_val(&policy) as u32,
    );
    let dark: i32 = (style.palette.surface == Palette::new(true).surface).into();
    DwmSetWindowAttribute(
        popup,
        DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
        (&dark as *const i32).cast(),
        std::mem::size_of_val(&dark) as u32,
    );
    let border = if dark != 0 {
        rgb(70, 70, 70)
    } else {
        rgb(220, 220, 220)
    };
    DwmSetWindowAttribute(
        popup,
        DWMWA_BORDER_COLOR as u32,
        (&border as *const COLORREF).cast(),
        std::mem::size_of_val(&border) as u32,
    );
    // The pending native show lays out and paints it. No reentrant positioning.
}

unsafe fn detach_popup(style: &Style) {
    let popup = style.popup.replace(std::ptr::null_mut());
    if !popup.is_null() {
        if let Some(original) = style.shadow_class.take() {
            let current = GetClassLongPtrW(popup, GCL_STYLE);
            SetClassLongPtrW(
                popup,
                GCL_STYLE,
                (current | (original & CS_DROPSHADOW as usize)) as isize,
            );
        }
        RemoveWindowSubclass(popup, Some(popup_frame), POPUP_SUBCLASS);
    }
}

unsafe extern "system" fn popup_frame(
    hwnd: HWND,
    message: u32,
    wp: WPARAM,
    lp: LPARAM,
    _: usize,
    data: usize,
) -> LRESULT {
    let style = &*(data as *const Style);
    if message == WM_NCDESTROY {
        detach_popup(style);
        return DefSubclassProc(hwnd, message, wp, lp);
    }
    // Owner-drawn items do not replace the stock menu's beveled NC border.
    // DWM rounds the outside; paint its inner border with the same flat surface
    // instead of leaving the old dark right/bottom bevel beside the round edge.
    if message == WM_NCPAINT && paint_frame(hwnd, style) {
        return 0;
    }
    let result = DefSubclassProc(hwnd, message, wp, lp);
    if message == WM_PAINT || message == WM_NCACTIVATE {
        // The native menu can repaint its edge with the client/activation pass.
        paint_frame(hwnd, style);
    }
    result
}

unsafe fn paint_frame(hwnd: HWND, style: &Style) -> bool {
    style
        .frame_paints
        .set(style.frame_paints.get().saturating_add(1));
    let mut bounds = RECT::default();
    let mut client = RECT::default();
    let mut origin = POINT::default();
    if GetWindowRect(hwnd, &mut bounds) == 0
        || GetClientRect(hwnd, &mut client) == 0
        || ClientToScreen(hwnd, &mut origin) == 0
    {
        return false;
    }
    let dc = GetWindowDC(hwnd);
    if dc.is_null() {
        return false;
    }
    let saved = SaveDC(dc);
    let mut painted = false;
    if saved != 0 {
        let x = origin.x - bounds.left;
        let y = origin.y - bounds.top;
        // Never erase an item, its current hover, or a scrolling menu's client.
        if ExcludeClipRect(
            dc,
            client.left + x,
            client.top + y,
            client.right + x,
            client.bottom + y,
        ) != ERROR
        {
            let rect = RECT {
                left: 0,
                top: 0,
                right: bounds.right - bounds.left,
                bottom: bounds.bottom - bounds.top,
            };
            painted = FillRect(dc, &rect, style.surface) != 0;
        }
        RestoreDC(dc, saved);
    }
    ReleaseDC(hwnd, dc);
    painted
}

unsafe fn draw_item(style: &Style, item: &Item, draw: &DRAWITEMSTRUCT) {
    let dc = draw.hDC;
    let saved = SaveDC(dc);
    if saved == 0 {
        return;
    }
    let rect = draw.rcItem;
    let selected = draw.itemState & ODS_SELECTED != 0;
    FillRect(dc, &rect, style.surface);
    if selected {
        let inset = px(style.dpi, 4);
        let vertical = px(style.dpi, 2);
        let radius = px(style.dpi, 6);
        SelectObject(dc, style.hover);
        SelectObject(dc, GetStockObject(NULL_PEN));
        RoundRect(
            dc,
            rect.left + inset,
            rect.top + vertical,
            rect.right - inset,
            rect.bottom - vertical,
            radius * 2,
            radius * 2,
        );
    }
    SelectObject(dc, style.font);
    SetBkMode(dc, TRANSPARENT as i32);
    let color = if item.danger {
        style.palette.danger
    } else {
        style.palette.text
    };
    SetTextColor(dc, color);
    let mut label = RECT {
        left: rect.left + px(style.dpi, 40),
        top: rect.top,
        right: rect.right - px(style.dpi, 12),
        bottom: rect.bottom,
    };
    DrawTextW(
        dc,
        item.label.as_ptr(),
        item.label.len() as i32,
        &mut label,
        DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX,
    );
    SetTextColor(dc, style.palette.muted);
    if !item.shortcut.is_empty() {
        DrawTextW(
            dc,
            item.shortcut.as_ptr(),
            item.shortcut.len() as i32,
            &mut label,
            DT_SINGLELINE | DT_VCENTER | DT_RIGHT | DT_NOPREFIX,
        );
    }
    let background = if selected {
        style.palette.hover
    } else {
        style.palette.surface
    };
    let pixels = matte(item.icon.rgba(), color, background);
    let info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: item.icon.width() as i32,
            biHeight: -(item.icon.height() as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..Default::default()
        },
        ..Default::default()
    };
    let size = px(style.dpi, 16);
    SetStretchBltMode(dc, HALFTONE);
    SetBrushOrgEx(dc, 0, 0, std::ptr::null_mut());
    StretchDIBits(
        dc,
        rect.left + px(style.dpi, 12),
        rect.top + (rect.bottom - rect.top - size) / 2,
        size,
        size,
        0,
        0,
        item.icon.width() as i32,
        item.icon.height() as i32,
        pixels.as_ptr().cast(),
        &info,
        DIB_RGB_COLORS,
        SRCCOPY,
    );
    RestoreDC(dc, saved);
}

fn matte(rgba: &[u8], foreground: COLORREF, background: COLORREF) -> Vec<u8> {
    rgba.chunks_exact(4)
        .flat_map(|pixel| {
            let alpha = u32::from(pixel[3]);
            let blend = |shift: u32| {
                ((((foreground >> shift) & 255) * alpha
                    + ((background >> shift) & 255) * (255 - alpha)
                    + 127)
                    / 255) as u8
            };
            [blend(16), blend(8), blend(0), 0]
        })
        .collect()
}
fn icon(action: &str, large: bool) -> Result<Image<'static>, String> {
    macro_rules! bytes {
        ($name:literal) => {
            if large {
                include_bytes!(concat!("../../icons/menu/", $name, "-32.png")).as_slice()
            } else {
                include_bytes!(concat!("../../icons/menu/", $name, "-16.png")).as_slice()
            }
        };
    }
    let bytes = match action {
        "details" => bytes!("info"),
        "pause" | "pause-queue" => bytes!("pause"),
        "resume" | "resume-queue" => bytes!("play"),
        "requeue" | "retry-all" => bytes!("retry"),
        "open-file" => bytes!("file"),
        "open-folder" | "open-downloads" | "group-show" => bytes!("folder-open"),
        "remove" | "clear-done" => bytes!("trash"),
        "new-task" | "group-add" => bytes!("plus"),
        "settings" | "group-edit" => bytes!("settings"),
        "group-manage" => bytes!("folder"),
        "undo" => bytes!("undo"),
        "redo" => bytes!("redo"),
        "cut" => bytes!("cut"),
        "copy" => bytes!("copy"),
        "paste" => bytes!("paste"),
        "select-all" => bytes!("select-all"),
        _ => return Err("Unavailable menu icon".into()),
    };
    Image::from_bytes(bytes).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn owner_draw_handles_empty_shortcuts_and_both_themes() {
        use super::*;
        unsafe {
            for dark in [false, true] {
                for action in ["group-edit", "copy"] {
                    for selected in [false, true] {
                        let palette = Palette::new(dark);
                        let style = Style {
                            popup: Cell::new(std::ptr::null_mut()),
                            shadow_class: Cell::new(None),
                            shadow_suppressed: Cell::new(false),
                            saw_popup: Cell::new(false),
                            bound_popup: Cell::new(false),
                            frame_paints: Cell::new(0),
                            shadow_windows: Cell::new(0),
                            corner_result: Cell::new(i32::MIN),
                            menu: std::ptr::null_mut(),
                            dpi: 144,
                            width: 360,
                            height: 54,
                            palette,
                            font: CreateFontIndirectW(&LOGFONTW {
                                lfHeight: -20,
                                ..Default::default()
                            }),
                            surface: CreateSolidBrush(palette.surface),
                            hover: CreateSolidBrush(palette.hover),
                            items: vec![],
                        };
                        let text = super::super::label(action).unwrap();
                        let (label, shortcut) = text.split_once('\t').unwrap_or((text, ""));
                        let item = Item {
                            label: label.encode_utf16().collect(),
                            shortcut: shortcut.encode_utf16().collect(),
                            icon: icon(action, true).unwrap(),
                            danger: false,
                        };
                        let dc = CreateCompatibleDC(std::ptr::null_mut());
                        let info = BITMAPINFO {
                            bmiHeader: BITMAPINFOHEADER {
                                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                                biWidth: 360,
                                biHeight: -54,
                                biPlanes: 1,
                                biBitCount: 32,
                                biCompression: BI_RGB,
                                ..Default::default()
                            },
                            ..Default::default()
                        };
                        let mut bits = std::ptr::null_mut();
                        let bitmap = CreateDIBSection(
                            dc,
                            &info,
                            DIB_RGB_COLORS,
                            &mut bits,
                            std::ptr::null_mut(),
                            0,
                        );
                        assert!(!dc.is_null() && !bitmap.is_null());
                        let original = SelectObject(dc, bitmap);
                        draw_item(
                            &style,
                            &item,
                            &DRAWITEMSTRUCT {
                                hDC: dc,
                                itemState: if selected { ODS_SELECTED } else { 0 },
                                rcItem: RECT {
                                    left: 0,
                                    top: 0,
                                    right: 360,
                                    bottom: 54,
                                },
                                ..Default::default()
                            },
                        );
                        assert_eq!(GetPixel(dc, 0, 0), palette.surface);
                        assert_eq!(
                            GetPixel(dc, 200, 20),
                            if selected {
                                palette.hover
                            } else {
                                palette.surface
                            }
                        );
                        SelectObject(dc, original);
                        DeleteObject(bitmap);
                        DeleteDC(dc);
                    }
                }
            }
        }
    }
    #[test]
    fn icons_cover_actions_and_matte_preserves_transparency() {
        for action in super::super::super::ACTIONS {
            for large in [false, true] {
                let image = super::icon(action, large).unwrap();
                assert_eq!(image.width(), if large { 32 } else { 16 });
            }
        }
        assert_eq!(
            super::matte(
                &[0, 0, 0, 0, 0, 0, 0, 255],
                super::rgb(32, 32, 32),
                super::rgb(255, 255, 255)
            ),
            [255, 255, 255, 0, 32, 32, 32, 0]
        );
    }
}
