use crate::{color, render::Renderer, style::*, v2, Model};
use std::{
    cell::{Cell, RefCell},
    sync::atomic::{AtomicBool, Ordering},
};
use windows::{
    core::*,
    System::{DispatcherQueue, DispatcherQueueController},
    Win32::{
        Foundation::*,
        Graphics::{Dwm::*, Gdi::*},
        System::{
            LibraryLoader::GetModuleHandleW,
            WinRT::{Composition::*, *},
        },
        UI::{
            Controls::WM_MOUSELEAVE, HiDpi::GetDpiForWindow, Input::KeyboardAndMouse::*,
            WindowsAndMessaging::*,
        },
    },
    UI::{
        Composition::{Desktop::DesktopWindowTarget, *},
        ViewManagement::UISettings,
    },
};
use windows_numerics::Vector3;
const PAD: f32 = SHADOW_PAD;
const MENU_KEY: u32 = WM_APP + 0x3d1;
pub fn key(code: u32) {
    ACTIVE.with(|s| unsafe {
        if !s.get().is_invalid() {
            let _ = PostMessageW(
                Some(s.get()),
                MENU_KEY,
                WPARAM(code as usize),
                LPARAM(SESSION.with(Cell::get)),
            );
        }
    });
}
thread_local! {
    static CACHE:RefCell<Option<Host>>=const{RefCell::new(None)};
    static ACTIVE:Cell<HWND>=const{Cell::new(HWND(std::ptr::null_mut()))};
    static STOP:Cell<bool>=const{Cell::new(false)};
    static SESSION:Cell<isize>=const{Cell::new(0)};
}
pub fn dismiss() {
    STOP.with(|s| s.set(true));
    ACTIVE.with(|s| unsafe {
        if !s.get().is_invalid() {
            let _ = ShowWindow(s.get(), SW_HIDE);
            let _ = PostMessageW(Some(s.get()), WM_NULL, WPARAM(0), LPARAM(0));
        }
    });
}
/// Raise the popup on every opening, including unchanged-geometry cache hits.
/// The owner keeps focus and its own topmost setting is never changed.
pub unsafe fn show_popup(hwnd: HWND, owner: HWND) -> Result<()> {
    SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, owner.0 as isize);
    if GetWindowLongPtrW(hwnd, GWLP_HWNDPARENT) != owner.0 as isize {
        return Err(Error::new(E_FAIL, "Cannot attach menu owner"));
    }
    SetWindowPos(
        hwnd,
        Some(HWND_TOPMOST),
        0,
        0,
        0,
        0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_SHOWWINDOW,
    )
}
/// Hide before demoting. Detach first: HWND_NOTOPMOST can otherwise demote
/// a topmost owner as well. The next opening explicitly attaches its caller.
pub unsafe fn park_popup(hwnd: HWND) -> Result<()> {
    let _ = ShowWindow(hwnd, SW_HIDE);
    SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, 0);
    if GetWindowLongPtrW(hwnd, GWLP_HWNDPARENT) != 0 {
        return Err(Error::new(E_FAIL, "Cannot detach menu owner"));
    }
    SetWindowPos(
        hwnd,
        Some(HWND_NOTOPMOST),
        0,
        0,
        0,
        0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
    )
}
unsafe extern "system" fn proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    match msg {
        WM_MOUSEACTIVATE => LRESULT(MA_NOACTIVATE as isize),
        WM_ERASEBKGND => LRESULT(1),
        WM_CLOSE | WM_CANCELMODE => {
            dismiss();
            LRESULT(0)
        }
        WM_ACTIVATEAPP if w.0 == 0 => {
            dismiss();
            DefWindowProcW(hwnd, msg, w, l)
        }
        WM_CAPTURECHANGED if l.0 != 0 => {
            dismiss();
            DefWindowProcW(hwnd, msg, w, l)
        }
        WM_SETTINGCHANGE | WM_THEMECHANGED => {
            dismiss();
            DefWindowProcW(hwnd, msg, w, l)
        }
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let _ = BeginPaint(hwnd, &mut ps);
            let _ = EndPaint(hwnd, &ps);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, w, l),
    }
}
struct Host {
    hwnd: HWND,
    _queue: Option<DispatcherQueueController>,
    compositor: Compositor,
    _target: DesktopWindowTarget,
    root: ContainerVisual,
    clip: ContainerVisual,
    shape: CompositionRoundedRectangleGeometry,
    glass: SpriteVisual,
    tint: SpriteVisual,
    tint_brush: CompositionColorBrush,
    shadow_visual: SpriteVisual,
    silhouette: ShapeVisual,
    surface: CompositionVisualSurface,
    shadow: DropShadow,
    renderer: Option<Renderer>,
    key: Vec<String>,
    dpi: f32,
    material: Option<(bool, bool)>,
    settings: UISettings,
    tracking_mouse: bool,
}
impl Drop for Host {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyWindow(self.hwnd);
        }
    }
}
impl Host {
    unsafe fn new() -> Result<Self> {
        let queue = if DispatcherQueue::GetForCurrentThread().is_ok() {
            None
        } else {
            Some(CreateDispatcherQueueController(DispatcherQueueOptions {
                dwSize: std::mem::size_of::<DispatcherQueueOptions>() as _,
                threadType: DQTYPE_THREAD_CURRENT,
                apartmentType: DQTAT_COM_STA,
            })?)
        };
        let instance = HINSTANCE(GetModuleHandleW(None)?.0);
        let class = w!("TrueDown.CompositionMenu.v1");
        let wc = WNDCLASSW {
            hInstance: instance,
            lpszClassName: class,
            lpfnWndProc: Some(proc),
            hCursor: LoadCursorW(None, IDC_ARROW)?,
            ..Default::default()
        };
        if RegisterClassW(&wc) == 0 && GetLastError() != ERROR_CLASS_ALREADY_EXISTS {
            return Err(Error::from_thread());
        }
        let hwnd = CreateWindowExW(
            WS_EX_NOREDIRECTIONBITMAP | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
            class,
            w!("TrueDown 操作菜单"),
            WS_POPUP,
            0,
            0,
            1,
            1,
            None,
            None,
            Some(instance),
            None,
        )?;
        let result = (|| -> Result<Self> {
            let yes = BOOL(1);
            DwmSetWindowAttribute(hwnd, DWMWA_USE_HOSTBACKDROPBRUSH, &yes as *const _ as _, 4)?;
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_TRANSITIONS_FORCEDISABLED,
                &yes as *const _ as _,
                4,
            )?;
            let corners = DWMWCP_DONOTROUND;
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &corners as *const _ as _,
                4,
            )?;
            let compositor = Compositor::new()?;
            let target = compositor
                .cast::<ICompositorDesktopInterop>()?
                .CreateDesktopWindowTarget(hwnd, true)?;
            let root = compositor.CreateContainerVisual()?;
            target.SetRoot(&root)?;
            let shadow_visual = compositor.CreateSpriteVisual()?;
            root.Children()?.InsertAtTop(&shadow_visual)?;
            let clip = compositor.CreateContainerVisual()?;
            root.Children()?.InsertAtTop(&clip)?;
            let shape = compositor.CreateRoundedRectangleGeometry()?;
            clip.SetClip(&compositor.CreateGeometricClipWithGeometry(&shape)?)?;
            let glass = compositor.CreateSpriteVisual()?;
            glass.SetBrush(&compositor.CreateHostBackdropBrush()?)?;
            clip.Children()?.InsertAtTop(&glass)?;
            let tint = compositor.CreateSpriteVisual()?;
            let tint_brush = compositor.CreateColorBrush()?;
            tint.SetBrush(&tint_brush)?;
            clip.Children()?.InsertAtTop(&tint)?;
            let silhouette = compositor.CreateShapeVisual()?;
            let mask = compositor.CreateSpriteShapeWithGeometry(&shape)?;
            mask.SetFillBrush(&compositor.CreateColorBrushWithColor(color(255, 255, 255, 255))?)?;
            silhouette.Shapes()?.Append(&mask)?;
            let surface = compositor.CreateVisualSurface()?;
            surface.SetSourceVisual(&silhouette)?;
            let shadow = compositor.CreateDropShadow()?;
            shadow.SetMask(&compositor.CreateSurfaceBrushWithSurface(&surface)?)?;
            shadow.SetColor(color(255, 0, 0, 0))?;
            shadow_visual.SetShadow(&shadow)?;
            let settings = UISettings::new()?;
            Ok(Self {
                hwnd,
                _queue: queue,
                compositor,
                _target: target,
                root,
                clip,
                shape,
                glass,
                tint,
                tint_brush,
                shadow_visual,
                silhouette,
                surface,
                shadow,
                renderer: None,
                key: vec![],
                dpi: 0.,
                material: None,
                settings,
                tracking_mouse: false,
            })
        })();
        if result.is_err() {
            let _ = DestroyWindow(hwnd);
        }
        result
    }
    unsafe fn prepare(
        &mut self,
        owner: HWND,
        key: &[String],
        make: impl FnOnce() -> std::result::Result<Model, String>,
        point: POINT,
        dark: bool,
    ) -> std::result::Result<(), String> {
        // Cache identity comes only from the native allowlisted action sequence.
        let changed = self.key != key || self.renderer.is_none();
        if changed {
            let model = make()?;
            model.validate().map_err(|e| e.to_string())?;
            if let Some(renderer) = &mut self.renderer {
                renderer.set_model(model).map_err(|e| e.to_string())?;
            } else {
                self.renderer = Some(
                    Renderer::new(&self.compositor, &self.clip, model)
                        .map_err(|e| e.to_string())?,
                );
            }
            self.key = key.to_vec();
        }
        self.place(owner, point, dark, changed)
            .map_err(|e| e.to_string())
    }
    unsafe fn place(&mut self, owner: HWND, point: POINT, dark: bool, changed: bool) -> Result<()> {
        let model = self.renderer.as_ref().unwrap().model();
        let (width, height) = (model.width, model.height);
        let mut monitor = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as _,
            ..Default::default()
        };
        if !GetMonitorInfoW(
            MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST),
            &mut monitor,
        )
        .as_bool()
        {
            return Err(Error::from_thread());
        }
        let mut dpi = GetDpiForWindow(owner).max(96) as f32 / 96.;
        for _ in 0..2 {
            let w = (width * dpi).round() as i32;
            let h = (height * dpi).round() as i32;
            let pad = (PAD * dpi).round() as i32;
            // Let HMENU handle unusually small work areas instead of truncating actions.
            if w > monitor.rcWork.right - monitor.rcWork.left
                || h > monitor.rcWork.bottom - monitor.rcWork.top
            {
                return Err(Error::new(E_FAIL, "Menu exceeds work area"));
            }
            let x = point.x.clamp(monitor.rcWork.left, monitor.rcWork.right - w) - pad;
            let y = point.y.clamp(monitor.rcWork.top, monitor.rcWork.bottom - h) - pad;
            let mut rect = RECT::default();
            GetWindowRect(self.hwnd, &mut rect)?;
            if rect.left != x
                || rect.top != y
                || rect.right - rect.left != w + 2 * pad
                || rect.bottom - rect.top != h + 2 * pad
            {
                let mut flags = SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER;
                if rect.right - rect.left == w + 2 * pad && rect.bottom - rect.top == h + 2 * pad {
                    flags |= SWP_NOSIZE;
                }
                SetWindowPos(self.hwnd, None, x, y, w + 2 * pad, h + 2 * pad, flags)?;
            }
            let actual = GetDpiForWindow(self.hwnd) as f32 / 96.;
            if actual == dpi {
                break;
            }
            dpi = actual;
        }
        if self.dpi != dpi || changed {
            self.dpi = dpi;
            let size = v2(width * dpi, height * dpi);
            self.root.SetOffset(Vector3 {
                X: PAD * dpi,
                Y: PAD * dpi,
                Z: 0.,
            })?;
            self.clip.SetSize(size)?;
            self.shape.SetSize(size)?;
            self.shape.SetCornerRadius(v2(CORNER * dpi, CORNER * dpi))?;
            for visual in [&self.glass, &self.tint, &self.shadow_visual] {
                visual.SetSize(size)?;
            }
            self.silhouette.SetSize(size)?;
            self.surface.SetSourceSize(size)?;
            self.shadow.SetBlurRadius(SHADOW_BLUR * dpi)?;
            self.shadow.SetOffset(Vector3 {
                X: 0.,
                Y: SHADOW_OFFSET * dpi,
                Z: 0.,
            })?;
        }
        let solid = !self.settings.AdvancedEffectsEnabled().unwrap_or(false);
        if self.material != Some((dark, solid)) {
            let alpha = if solid { 255 } else { TINT_ALPHA };
            let palette = palette(dark);
            let [r, g, b] = palette.surface;
            self.tint_brush.SetColor(color(alpha, r, g, b))?;
            self.glass.SetIsVisible(!solid)?;
            self.shadow.SetOpacity(palette.shadow)?;
            self.material = Some((dark, solid));
        }
        self.renderer
            .as_mut()
            .unwrap()
            .appearance(dpi, dark, false)?;
        self.renderer.as_mut().unwrap().select(None)?;
        Ok(())
    }
}
// All callers must execute on the HWND's UI thread. No per-open devices, timer,
// worker, global hook, screenshot, or frame polling is created.
pub unsafe fn track(
    owner: isize,
    point: (i32, i32),
    dark: bool,
    visible_owner: bool,
    key: &[String],
    cancelled: &AtomicBool,
    make: impl FnOnce() -> std::result::Result<Model, String>,
) -> std::result::Result<Option<usize>, String> {
    if ACTIVE.with(|s| !s.get().is_invalid()) {
        return Err("Native menu already tracking".into());
    }
    let owner = HWND(owner as _);
    let mut host = CACHE
        .with(|c| c.borrow_mut().take())
        .map(Ok)
        .unwrap_or_else(|| Host::new().map_err(|e| e.to_string()))?;
    let prepared = host.prepare(
        owner,
        key,
        make,
        POINT {
            x: point.0,
            y: point.1,
        },
        dark,
    );
    let result = match prepared {
        Ok(()) if !cancelled.load(Ordering::SeqCst) => {
            run(&mut host, owner, visible_owner, cancelled).map_err(|e| e.to_string())
        }
        Ok(()) => Ok(None),
        Err(e) => Err(e),
    };
    let parked = park_popup(host.hwnd);
    if host.tracking_mouse {
        let mut tracking = TRACKMOUSEEVENT {
            cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as _,
            dwFlags: TME_CANCEL | TME_LEAVE,
            hwndTrack: host.hwnd,
            dwHoverTime: 0,
        };
        let _ = TrackMouseEvent(&mut tracking);
        host.tracking_mouse = false;
    }
    if GetCapture() == host.hwnd {
        let _ = ReleaseCapture();
    }
    ACTIVE.with(|s| s.set(HWND::default()));
    if result.is_ok() && parked.is_ok() {
        CACHE.with(|c| *c.borrow_mut() = Some(host));
    } // discard a broken graphics cache
    result
}
unsafe fn run(
    host: &mut Host,
    owner: HWND,
    visible_owner: bool,
    cancelled: &AtomicBool,
) -> Result<Option<usize>> {
    STOP.with(|s| s.set(false));
    ACTIVE.with(|s| s.set(host.hwnd));
    let session = SESSION.with(|s| {
        let next = s.get().wrapping_add(1);
        s.set(next);
        next
    });
    if cancelled.load(Ordering::SeqCst) || GetForegroundWindow() != owner {
        return Ok(None);
    }
    show_popup(host.hwnd, owner)?;
    let mut pressed = None;
    loop {
        if STOP.with(Cell::get)
            || cancelled.load(Ordering::SeqCst)
            || !IsWindow(Some(owner)).as_bool()
            || GetForegroundWindow() != owner
            || (visible_owner && !IsWindowVisible(owner).as_bool())
        {
            return Ok(None);
        }
        let mut msg = MSG::default();
        let got = GetMessageW(&mut msg, None, 0, 0).0;
        if got < 0 {
            return Err(Error::from_thread());
        }
        if got == 0 {
            PostQuitMessage(msg.wParam.0 as i32);
            return Ok(None);
        }
        if msg.message == MENU_KEY && msg.lParam.0 != session {
            continue;
        }
        if STOP.with(Cell::get) || cancelled.load(Ordering::SeqCst) {
            let _ = ShowWindow(host.hwnd, SW_HIDE);
            if msg.hwnd != host.hwnd {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            return Ok(None);
        }
        let is_mouse = matches!(
            msg.message,
            WM_MOUSEMOVE
                | WM_LBUTTONDOWN
                | WM_LBUTTONUP
                | WM_RBUTTONDOWN
                | WM_RBUTTONUP
                | WM_MBUTTONDOWN
                | WM_XBUTTONDOWN
                | WM_MOUSEWHEEL
                | WM_MOUSEHWHEEL
                | WM_NCLBUTTONDOWN
                | WM_NCRBUTTONDOWN
                | WM_NCMBUTTONDOWN
                | WM_NCXBUTTONDOWN
        );
        let renderer = host.renderer.as_mut().unwrap();
        if msg.message == WM_MOUSELEAVE && msg.hwnd == host.hwnd {
            host.tracking_mouse = false;
            renderer.select(None)?;
            continue;
        }
        if is_mouse {
            let mut p = msg.pt;
            let _ = ScreenToClient(host.hwnd, &mut p);
            let x = p.x as f32 / host.dpi - PAD;
            let y = p.y as f32 / host.dpi - PAD;
            let inside = renderer.model().inside(x, y);
            if msg.message == WM_MOUSEMOVE {
                renderer.select(if inside {
                    renderer.model().row_at(x, y)
                } else {
                    None
                })?;
                if msg.hwnd == host.hwnd {
                    if !host.tracking_mouse {
                        let mut tracking = TRACKMOUSEEVENT {
                            cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as _,
                            dwFlags: TME_LEAVE,
                            hwndTrack: host.hwnd,
                            dwHoverTime: 0,
                        };
                        host.tracking_mouse = TrackMouseEvent(&mut tracking).is_ok();
                    }
                    continue;
                }
            } else if !inside
                || matches!(
                    msg.message,
                    WM_MOUSEWHEEL | WM_MOUSEHWHEEL | WM_MBUTTONDOWN | WM_XBUTTONDOWN
                )
            {
                let _ = ShowWindow(host.hwnd, SW_HIDE);
                if GetCapture() == host.hwnd {
                    let _ = ReleaseCapture();
                }
                // The message keeps its original target: other controls receive
                // their click, including the next right-click menu request.
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
                return Ok(None);
            } else if msg.hwnd == host.hwnd {
                let row = renderer.model().row_at(x, y);
                if matches!(msg.message, WM_LBUTTONDOWN | WM_RBUTTONDOWN) {
                    pressed = row;
                    SetCapture(host.hwnd);
                    renderer.select(row)?;
                } else if matches!(msg.message, WM_LBUTTONUP | WM_RBUTTONUP) {
                    if GetCapture() == host.hwnd {
                        let _ = ReleaseCapture();
                    }
                    if pressed.is_some() && pressed == row {
                        return Ok(row);
                    }
                    pressed = None;
                }
                continue;
            }
        }
        if msg.message == WM_KEYDOWN
            || msg.message == WM_SYSKEYDOWN
            || (msg.message == MENU_KEY && msg.hwnd == host.hwnd)
        {
            let count = renderer.model().items.len();
            let selected = renderer.selected();
            match msg.wParam.0 as u16 {
                0x1b => return Ok(None),
                0x09 => {
                    let _ = ShowWindow(host.hwnd, SW_HIDE);
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                    return Ok(None);
                }
                0x26 => renderer.select(Some(
                    selected
                        .map(|i| (i + count - 1) % count)
                        .unwrap_or(count - 1),
                ))?,
                0x28 => renderer.select(Some(selected.map(|i| (i + 1) % count).unwrap_or(0)))?,
                0x24 => renderer.select(Some(0))?,
                0x23 => renderer.select(Some(count - 1))?,
                0x0d | 0x20 => {
                    if selected.is_some() {
                        return Ok(selected);
                    }
                }
                _ => {
                    let _ = ShowWindow(host.hwnd, SW_HIDE);
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                    return Ok(None);
                }
            }
            continue;
        }
        if matches!(msg.message, WM_CANCELMODE | WM_CAPTURECHANGED) && msg.hwnd == host.hwnd {
            return Ok(None);
        }
        if (msg.hwnd == owner && matches!(msg.message, WM_MOVE | WM_SIZE | WM_CLOSE | WM_DESTROY))
            || (msg.message == WM_ACTIVATEAPP && msg.wParam.0 == 0)
        {
            let _ = ShowWindow(host.hwnd, SW_HIDE);
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
            return Ok(None);
        }
        let _ = TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
}
