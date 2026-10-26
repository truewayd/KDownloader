#![windows_subsystem = "windows"]
// Independent native prototype: no browser, TrueDown core, downloads or clipboard.
use std::{
    cell::RefCell,
    fs::{File, OpenOptions},
    io::{BufWriter, Write},
    path::PathBuf,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use windows::{
    core::*,
    Win32::{
        Foundation::*,
        Graphics::{Dwm::*, Gdi::*},
        System::{
            Com::*,
            LibraryLoader::*,
            WinRT::{Composition::*, *},
        },
        UI::{HiDpi::*, Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
    },
    UI::{
        Color,
        Composition::{Desktop::DesktopWindowTarget, *},
        ViewManagement::{UIColorType, UISettings},
    },
};
use windows_numerics::{Vector2, Vector3};
mod render;
mod sample;
const W: f32 = 272.;
const H: f32 = 179.;
const CORNER: f32 = truedown_native_menu::style::CORNER;
const PAD: f32 = truedown_native_menu::style::SHADOW_PAD;
const ACTION: u32 = WM_APP + 1;
const WM_MOUSELEAVE: u32 = 0x02a3;
thread_local! {
    static APP:RefCell<Option<App>>=const{RefCell::new(None)};
    static DATA:RefCell<PathBuf>=RefCell::new(PathBuf::new());
}
fn log(s: impl AsRef<str>) {
    DATA.with(|d| {
        if let Ok(mut f) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(d.borrow().join("events.log"))
        {
            let _ = writeln!(f, "{}", s.as_ref());
        }
    })
}
fn v2(x: f32, y: f32) -> Vector2 {
    Vector2 { X: x, Y: y }
}
fn v3(x: f32, y: f32, z: f32) -> Vector3 {
    Vector3 { X: x, Y: y, Z: z }
}
fn color(a: u8, r: u8, g: u8, b: u8) -> Color {
    Color {
        A: a,
        R: r,
        G: g,
        B: b,
    }
}
fn system_dark() -> bool {
    UISettings::new()
        .and_then(|s| s.GetColorValue(UIColorType::Background))
        .map(|c| (c.R as u32 + c.G as u32 + c.B as u32) < 384)
        .unwrap_or(false)
}
struct App {
    hwnd: HWND,
    owner: HWND,
    _compositor: Compositor,
    _target: DesktopWindowTarget,
    root: ContainerVisual,
    clipped: ContainerVisual,
    geometry: CompositionRoundedRectangleGeometry,
    glass: SpriteVisual,
    tint: SpriteVisual,
    tint_brush: CompositionColorBrush,
    shadow_visual: SpriteVisual,
    silhouette: ShapeVisual,
    surface: CompositionVisualSurface,
    shadow: DropShadow,
    renderer: render::Renderer,
    dpi: f32,
    dark: bool,
    solid: bool,
    effective_solid: bool,
    visible: bool,
    ready: bool,
    tracking: bool,
    pressed: Option<usize>,
    generation: u32,
    started: Instant,
    deadline: Instant,
    last_transition: Instant,
    frame_seq: u64,
    step: u32,
    cycles: u32,
    stress: bool,
    auto: bool,
    capture: bool,
    exit_after: bool,
    saved_modes: u8,
    samples: BufWriter<File>,
    transitions: BufWriter<File>,
    sampler: Option<sample::Sampler>,
}
impl App {
    unsafe fn layout(&mut self) -> Result<()> {
        self.dpi = GetDpiForWindow(self.hwnd) as f32 / 96.;
        let d = self.dpi;
        let size = v2(W * d, H * d);
        self.root.SetOffset(v3(PAD * d, PAD * d, 0.))?;
        self.clipped.SetSize(size)?;
        self.geometry.SetSize(size)?;
        self.geometry.SetCornerRadius(v2(CORNER * d, CORNER * d))?;
        for visual in [&self.glass, &self.tint, &self.shadow_visual] {
            visual.SetSize(size)?;
        }
        self.silhouette.SetSize(size)?;
        self.surface.SetSourceSize(size)?;
        self.shadow
            .SetBlurRadius(truedown_native_menu::style::SHADOW_BLUR * d)?;
        self.shadow
            .SetOffset(v3(0., truedown_native_menu::style::SHADOW_OFFSET * d, 0.))?;
        self.renderer.appearance(d, self.dark, self.capture)?;
        Ok(())
    }
    fn theme(&mut self) -> Result<()> {
        // Both modes use the same retained HWND, clip and textures. Theme changes
        // update only brushes and the cached text surface; no shell rebuild.
        let effects = UISettings::new()
            .and_then(|settings| settings.AdvancedEffectsEnabled())
            .unwrap_or(false);
        self.effective_solid = self.solid || !effects;
        let alpha = if self.effective_solid {
            255
        } else {
            truedown_native_menu::style::TINT_ALPHA
        };
        let palette = truedown_native_menu::style::palette(self.dark);
        let [r, g, b] = palette.surface;
        self.tint_brush.SetColor(color(alpha, r, g, b))?;
        self.glass.SetIsVisible(!self.effective_solid)?;
        self.shadow.SetOpacity(palette.shadow)?;
        unsafe {
            self.layout()?;
            let material = if self.effective_solid {
                "Solid"
            } else {
                "Composition blur (Acrylic-style)"
            };
            SetWindowTextW(
                self.owner,
                &HSTRING::from(format!(
                    "Composition Menu Prototype - {material} - {}",
                    if self.dark { "Dark" } else { "Light" }
                )),
            )?;
        }
        log(format!(
            "native material: Composition HostBackdropBrush; dark={} requested_solid={} effective_solid={} tint_alpha={alpha}/255; no system Mica or Acrylic controller",
            self.dark, self.solid, self.effective_solid
        ));
        Ok(())
    }
    unsafe fn open(&mut self, point: POINT) -> Result<()> {
        if !self.ready {
            return Ok(());
        }
        let start = Instant::now();
        self.close()?;
        self.generation = self.generation.wrapping_add(1).max(1);
        let monitor = MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as _,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return Err(Error::from_thread());
        }
        let mut dpi = self.dpi;
        for _ in 0..2 {
            let pad = (PAD * dpi).round() as i32;
            let width = (W * dpi).round() as i32;
            let height = (H * dpi).round() as i32;
            let x = point.x.clamp(
                info.rcWork.left,
                (info.rcWork.right - width).max(info.rcWork.left),
            );
            let y = point.y.clamp(
                info.rcWork.top,
                (info.rcWork.bottom - height).max(info.rcWork.top),
            );
            // Compare with the real HWND rectangle (not a stale position cache).
            // Reopening only renews popup stacking; a pure move
            // should not trigger resize work on the retained Composition target.
            let mut current = RECT::default();
            GetWindowRect(self.hwnd, &mut current)?;
            let same_position = current.left == x - pad && current.top == y - pad;
            let same_size = current.right - current.left == width + 2 * pad
                && current.bottom - current.top == height + 2 * pad;
            if !same_position || !same_size {
                let mut flags = SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER;
                if same_position {
                    flags |= SWP_NOMOVE;
                }
                if same_size {
                    flags |= SWP_NOSIZE;
                }
                SetWindowPos(
                    self.hwnd,
                    None,
                    x - pad,
                    y - pad,
                    width + 2 * pad,
                    height + 2 * pad,
                    flags,
                )?;
            }
            let actual = GetDpiForWindow(self.hwnd) as f32 / 96.;
            if actual == dpi {
                break;
            }
            dpi = actual;
        }
        if dpi != self.dpi {
            self.layout()?;
            self.sampler = None;
        }
        self.renderer.select(None)?;
        self.pressed = None;
        truedown_native_menu::show_popup(self.hwnd, self.owner)?;
        self.visible = true;
        self.last_transition = Instant::now();
        if self.capture || self.stress {
            let _ = writeln!(
                self.transitions,
                "{:.3},{},open,{},{},{:.3},{}",
                self.started.elapsed().as_secs_f64() * 1000.,
                self.step,
                self.dark,
                self.solid,
                start.elapsed().as_secs_f64() * 1000.,
                self.effective_solid
            );
        }
        Ok(())
    }
    unsafe fn close(&mut self) -> Result<()> {
        if !self.visible {
            return Ok(());
        }
        let start = Instant::now();
        // Native surface disappears immediately. Retained textures need no wakeup timer.
        self.visible = false;
        self.pressed = None;
        if self.tracking {
            let mut cancel = TRACKMOUSEEVENT {
                cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as _,
                dwFlags: TME_CANCEL | TME_LEAVE,
                hwndTrack: self.hwnd,
                ..Default::default()
            };
            let _ = TrackMouseEvent(&mut cancel);
        }
        self.tracking = false;
        truedown_native_menu::park_popup(self.hwnd)?;
        if GetCapture() == self.hwnd {
            let _ = ReleaseCapture();
        }
        self.renderer.select(None)?;
        self.last_transition = Instant::now();
        if self.capture || self.stress {
            let _ = writeln!(
                self.transitions,
                "{:.3},{},close,{},{},{:.3},{}",
                self.started.elapsed().as_secs_f64() * 1000.,
                self.step,
                self.dark,
                self.solid,
                start.elapsed().as_secs_f64() * 1000.,
                self.effective_solid
            );
        }
        Ok(())
    }
    unsafe fn start_stress(&mut self) -> Result<()> {
        self.close()?;
        self.step = 0;
        self.stress = true;
        self.deadline = Instant::now() + std::time::Duration::from_millis(500);
        SetTimer(Some(self.owner), 1, 16, None);
        log(format!(
            "stress start cycles={} capture={}",
            self.cycles, self.capture
        ));
        Ok(())
    }
    unsafe fn tick(&mut self) -> Result<()> {
        if self.capture && self.stress {
            self.sample()?;
        }
        if self.auto
            && self.ready
            && !self.stress
            && self.step == 0
            && self.started.elapsed().as_millis() > 1500
        {
            self.auto = false;
            self.start_stress()?;
        }
        if !self.stress || Instant::now() < self.deadline {
            return Ok(());
        }
        if self.step >= self.cycles * 2 {
            self.close()?;
            self.stress = false;
            let _ = KillTimer(Some(self.owner), 1);
            self.samples.flush().ok();
            self.transitions.flush().ok();
            log("stress complete");
            DATA.with(|d| {
                let _ = std::fs::write(
                    d.borrow().join("complete.txt"),
                    format!(
                        "cycles={} samples={} elapsed_ms={:.3}",
                        self.cycles,
                        self.frame_seq,
                        self.started.elapsed().as_secs_f64() * 1000.
                    ),
                );
            });
            if self.exit_after {
                PostMessageW(Some(self.owner), WM_CLOSE, WPARAM(0), LPARAM(0))?;
            }
            return Ok(());
        }
        if self.step % 2 == 0 {
            let mode = (self.step / 2) / (self.cycles / 4).max(1);
            let dark = mode % 2 == 1;
            let solid = mode >= 2;
            if dark != self.dark || solid != self.solid {
                self.dark = dark;
                self.solid = solid;
                self.theme()?;
            }
            let mut p = POINT { x: 110, y: 110 };
            let _ = ClientToScreen(self.owner, &mut p);
            self.open(p)?;
        } else {
            self.close()?;
        }
        self.step += 1;
        self.deadline = Instant::now() + std::time::Duration::from_millis(120);
        Ok(())
    }
    unsafe fn sample(&mut self) -> Result<()> {
        // Only the synthetic owner's client area; abort capture if it loses foreground.
        if GetForegroundWindow() != self.owner {
            log("capture stopped: owner lost foreground");
            self.stress = false;
            let _ = KillTimer(Some(self.owner), 1);
            self.close()?;
            return Ok(());
        }
        if self.sampler.is_none() {
            self.sampler = Some(sample::Sampler::new(
                (W * self.dpi) as _,
                (H * self.dpi) as _,
            )?);
        }
        let mut r = RECT::default();
        GetWindowRect(self.hwnd, &mut r)?;
        let x = r.left + (PAD * self.dpi) as i32;
        let y = r.top + (PAD * self.dpi) as i32;
        let mut client = RECT::default();
        GetClientRect(self.owner, &mut client)?;
        let mut origin = POINT::default();
        let _ = ClientToScreen(self.owner, &mut origin);
        let sampler = self.sampler.as_mut().unwrap();
        if x < origin.x
            || y < origin.y
            || x + sampler.width > origin.x + client.right
            || y + sampler.height > origin.y + client.bottom
        {
            return Ok(());
        }
        let t = Instant::now();
        let m = sampler.read(x, y)?;
        self.frame_seq += 1;
        let _ = writeln!(
            self.samples,
            "{:.3},{},{},{},{},{},{:.3},{:.6},{:.6},{:.3},{}",
            self.started.elapsed().as_secs_f64() * 1000.,
            self.frame_seq,
            self.step,
            self.visible,
            self.dark,
            self.solid,
            self.last_transition.elapsed().as_secs_f64() * 1000.,
            m.black_ratio,
            m.green_ratio,
            t.elapsed().as_secs_f64() * 1000.,
            self.effective_solid
        );
        if m.black_ratio > 0.01 && self.frame_seq < 20000 {
            DATA.with(|d| {
                let _ = sampler.save(
                    &d.borrow()
                        .join(format!("suspect-{:05}.bmp", self.frame_seq)),
                );
            });
        }
        let mode = (self.dark as u8) + 2 * (self.solid as u8);
        let bit = 1 << mode;
        if self.visible
            && self.last_transition.elapsed().as_millis() > 65
            && m.green_ratio > 0.0001
            && self.saved_modes & bit == 0
        {
            self.saved_modes |= bit;
            DATA.with(|d| {
                let _ = sampler.save(&d.borrow().join(format!("mode-{mode}.bmp")));
            });
        }
        Ok(())
    }

    unsafe fn choose(&mut self, index: usize) -> Result<()> {
        if self.visible {
            PostMessageW(
                Some(self.owner),
                ACTION,
                WPARAM(index + 1),
                LPARAM(self.generation as isize),
            )?;
        }
        Ok(())
    }
    unsafe fn key(&mut self, key: u16) -> Result<()> {
        if !self.visible {
            return Ok(());
        }
        let selected = self.renderer.selected();
        let next = match key {
            0x26 => Some(selected.map(|i| (i + 4) % 5).unwrap_or(4)),
            0x28 => Some(selected.map(|i| (i + 1) % 5).unwrap_or(0)),
            0x24 => Some(0),
            0x23 => Some(4),
            0x0d | 0x20 => {
                if let Some(i) = selected {
                    self.choose(i)?;
                }
                return Ok(());
            }
            0x1b | 0x09 => {
                self.close()?;
                return Ok(());
            }
            _ => return Ok(()),
        };
        self.renderer.select(next)
    }
    unsafe fn mouse(&mut self, msg: u32, l: LPARAM) -> Result<()> {
        if !self.visible {
            return Ok(());
        }
        if msg == WM_CAPTURECHANGED {
            self.pressed = None;
            return Ok(());
        }
        if msg == WM_MOUSELEAVE {
            self.tracking = false;
            self.renderer.select(None)?;
            return Ok(());
        }
        let x = l.0 as i16 as f32 / self.dpi - PAD;
        let y = (l.0 >> 16) as i16 as f32 / self.dpi - PAD;
        let index = render::row_at(x, y);
        match msg {
            WM_MOUSEMOVE => {
                if !self.tracking {
                    let mut t = TRACKMOUSEEVENT {
                        cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as _,
                        dwFlags: TME_LEAVE,
                        hwndTrack: self.hwnd,
                        ..Default::default()
                    };
                    TrackMouseEvent(&mut t)?;
                    self.tracking = true;
                }
                self.renderer.select(index)?;
            }
            WM_LBUTTONDOWN => {
                if !render::inside(x, y) {
                    self.close()?;
                } else {
                    self.pressed = index;
                    SetCapture(self.hwnd);
                    self.renderer.select(index)?;
                }
            }
            WM_LBUTTONUP => {
                let pressed = self.pressed.take();
                if GetCapture() == self.hwnd {
                    let _ = ReleaseCapture();
                }
                if pressed.is_some() && pressed == index {
                    self.choose(index.unwrap())?;
                } else if !render::inside(x, y) {
                    self.close()?;
                }
            }
            _ => {}
        };
        Ok(())
    }
}
unsafe extern "system" fn popup_proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if msg == WM_MOUSEACTIVATE {
        return LRESULT(MA_NOACTIVATE as isize);
    }
    if msg == WM_ERASEBKGND {
        return LRESULT(1);
    }
    if msg == WM_NCHITTEST {
        let mut p = POINT {
            x: l.0 as i16 as i32,
            y: (l.0 >> 16) as i16 as i32,
        };
        let _ = ScreenToClient(hwnd, &mut p);
        let d = GetDpiForWindow(hwnd) as f32 / 96.;
        return LRESULT(
            if render::inside(p.x as f32 / d - PAD, p.y as f32 / d - PAD) {
                HTCLIENT as isize
            } else {
                HTTRANSPARENT as isize
            },
        );
    }
    if matches!(
        msg,
        WM_MOUSEMOVE | WM_MOUSELEAVE | WM_LBUTTONDOWN | WM_LBUTTONUP | WM_CAPTURECHANGED
    ) {
        APP.with(|slot| {
            if let Ok(mut a) = slot.try_borrow_mut() {
                if let Some(a) = a.as_mut() {
                    if let Err(e) = a.mouse(msg, l) {
                        log(format!("native input: {e}"));
                    }
                }
            }
        });
        return LRESULT(0);
    }
    if matches!(
        msg,
        WM_RBUTTONDOWN
            | WM_MBUTTONDOWN
            | WM_XBUTTONDOWN
            | WM_MOUSEWHEEL
            | WM_MOUSEHWHEEL
            | WM_CANCELMODE
    ) {
        APP.with(|slot| {
            if let Ok(mut a) = slot.try_borrow_mut() {
                if let Some(a) = a.as_mut() {
                    let _ = a.close();
                }
            }
        });
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, msg, w, l)
}
unsafe extern "system" fn owner_proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if msg == WM_DESTROY {
        PostQuitMessage(0);
        return LRESULT(0);
    }
    if msg == WM_PAINT {
        sample::paint_reference(hwnd);
        return LRESULT(0);
    }
    let mut handled = false;
    APP.with(|slot| {
        let Ok(mut slot) = slot.try_borrow_mut() else {
            return;
        };
        let Some(a) = slot.as_mut() else { return };
        handled = true;
        let result = (|| -> Result<()> {
            match msg {
                ACTION => {
                    if a.visible && l.0 as u32 == a.generation && (1..=5).contains(&w.0) {
                        a.close()?;
                        log(format!("synthetic native action {}", w.0));
                    }
                }
                WM_TIMER => {
                    if w.0 == 1 {
                        a.tick()?;
                    }
                }
                WM_THEMECHANGED | WM_SETTINGCHANGE | WM_DWMCOMPOSITIONCHANGED => {
                    a.dark = system_dark();
                    a.theme()?;
                    handled = false;
                }
                WM_CONTEXTMENU => {
                    if !a.stress {
                        let p = if l.0 == -1 {
                            let mut p = POINT { x: 110, y: 110 };
                            let _ = ClientToScreen(hwnd, &mut p);
                            p
                        } else {
                            POINT {
                                x: l.0 as i16 as i32,
                                y: (l.0 >> 16) as i16 as i32,
                            }
                        };
                        let mut local = p;
                        let _ = ScreenToClient(hwnd, &mut local);
                        let mut r = RECT::default();
                        GetClientRect(hwnd, &mut r)?;
                        if l.0 == -1
                            || (local.x >= 0
                                && local.y >= 0
                                && local.x < r.right
                                && local.y < r.bottom)
                        {
                            a.open(p)?;
                        } else {
                            a.close()?;
                            handled = false;
                        }
                    }
                }
                WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN
                | WM_MOUSEWHEEL | WM_MOUSEHWHEEL | WM_NCLBUTTONDOWN | WM_NCRBUTTONDOWN
                | WM_NCMBUTTONDOWN | WM_NCXBUTTONDOWN | WM_CANCELMODE | WM_MOVING | WM_SIZE => {
                    a.close()?;
                    handled = false;
                }
                WM_ACTIVATE => {
                    if w.0 & 0xffff == WA_INACTIVE as usize {
                        a.close()?;
                    }
                    handled = false;
                }
                WM_ACTIVATEAPP if w.0 == 0 => {
                    a.close()?;
                    handled = false;
                }
                WM_KEYDOWN => match w.0 as u16 {
                    x if x == VK_F2.0 => {
                        if !a.stress {
                            a.dark = !a.dark;
                            a.theme()?;
                        }
                    }
                    x if x == VK_F3.0 => {
                        if !a.stress {
                            a.solid = !a.solid;
                            a.theme()?;
                        }
                    }
                    x if x == VK_F5.0 => {
                        if !a.stress {
                            a.start_stress()?;
                        }
                    }
                    x if x == VK_ESCAPE.0 => {
                        a.stress = false;
                        a.auto = false;
                        let _ = KillTimer(Some(a.owner), 1);
                        a.close()?;
                        a.samples.flush().ok();
                        a.transitions.flush().ok();
                    }
                    key => a.key(key)?,
                },
                _ => handled = false,
            }
            Ok(())
        })();
        if let Err(e) = result {
            log(format!("native event {msg}: {e}"));
            let _ = a.close();
        }
    });
    if handled {
        LRESULT(0)
    } else {
        DefWindowProcW(hwnd, msg, w, l)
    }
}
unsafe fn run(data: PathBuf) -> Result<()> {
    let started = Instant::now();
    CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
    let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    let _queue = CreateDispatcherQueueController(DispatcherQueueOptions {
        dwSize: std::mem::size_of::<DispatcherQueueOptions>() as _,
        threadType: DQTYPE_THREAD_CURRENT,
        apartmentType: DQTAT_COM_STA,
    })?;
    let instance = HINSTANCE(GetModuleHandleW(None)?.0);
    for (name, proc) in [
        (
            w!("CompositionMenuPrototype"),
            Some(popup_proc as unsafe extern "system" fn(_, _, _, _) -> _),
        ),
        (
            w!("CompositionMenuTestBackground"),
            Some(owner_proc as unsafe extern "system" fn(_, _, _, _) -> _),
        ),
    ] {
        let wc = WNDCLASSW {
            hInstance: instance,
            lpszClassName: name,
            lpfnWndProc: proc,
            hCursor: LoadCursorW(None, IDC_ARROW)?,
            ..Default::default()
        };
        if RegisterClassW(&wc) == 0 {
            return Err(Error::from_thread());
        }
    }
    let dpi = GetDpiForSystem() as f32 / 96.;
    let owner = CreateWindowExW(
        WINDOW_EX_STYLE(0),
        w!("CompositionMenuTestBackground"),
        w!("Composition Menu Prototype - native Direct2D"),
        WS_OVERLAPPEDWINDOW,
        80,
        80,
        (720. * dpi) as _,
        (510. * dpi) as _,
        None,
        None,
        Some(instance),
        None,
    )?;
    let hwnd = CreateWindowExW(
        WS_EX_NOREDIRECTIONBITMAP | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
        w!("CompositionMenuPrototype"),
        w!("Native Composition Menu"),
        WS_POPUP,
        200,
        200,
        ((W + 2. * PAD) * dpi) as _,
        ((H + 2. * PAD) * dpi) as _,
        Some(owner),
        None,
        Some(instance),
        None,
    )?;
    let yes = BOOL(1);
    DwmSetWindowAttribute(hwnd, DWMWA_USE_HOSTBACKDROPBRUSH, &yes as *const _ as _, 4)?;
    let corners = DWMWCP_DONOTROUND;
    DwmSetWindowAttribute(
        hwnd,
        DWMWA_WINDOW_CORNER_PREFERENCE,
        &corners as *const _ as _,
        4,
    )?;
    DwmSetWindowAttribute(
        hwnd,
        DWMWA_TRANSITIONS_FORCEDISABLED,
        &yes as *const _ as _,
        4,
    )?;
    let compositor = Compositor::new()?;
    let interop: ICompositorDesktopInterop = compositor.cast()?;
    let target = interop.CreateDesktopWindowTarget(hwnd, true)?;
    let root = compositor.CreateContainerVisual()?;
    target.SetRoot(&root)?;
    let shadow_visual = compositor.CreateSpriteVisual()?;
    root.Children()?.InsertAtTop(&shadow_visual)?;
    let clipped = compositor.CreateContainerVisual()?;
    root.Children()?.InsertAtTop(&clipped)?;
    let geometry = compositor.CreateRoundedRectangleGeometry()?;
    clipped.SetClip(&compositor.CreateGeometricClipWithGeometry(&geometry)?)?;
    let glass = compositor.CreateSpriteVisual()?;
    glass.SetBrush(&compositor.CreateHostBackdropBrush()?)?;
    clipped.Children()?.InsertAtTop(&glass)?;
    let tint = compositor.CreateSpriteVisual()?;
    let tint_brush = compositor.CreateColorBrush()?;
    tint.SetBrush(&tint_brush)?;
    clipped.Children()?.InsertAtTop(&tint)?;
    let silhouette = compositor.CreateShapeVisual()?;
    let shape = compositor.CreateSpriteShapeWithGeometry(&geometry)?;
    shape.SetFillBrush(&compositor.CreateColorBrushWithColor(color(255, 255, 255, 255))?)?;
    silhouette.Shapes()?.Append(&shape)?;
    let surface = compositor.CreateVisualSurface()?;
    surface.SetSourceVisual(&silhouette)?;
    let shadow = compositor.CreateDropShadow()?;
    shadow.SetMask(&compositor.CreateSurfaceBrushWithSurface(&surface)?)?;
    shadow.SetColor(color(255, 0, 0, 0))?;
    shadow_visual.SetShadow(&shadow)?;
    let renderer = render::Renderer::new(&compositor, &clipped)?;
    let io = |e: std::io::Error| Error::new(E_FAIL, e.to_string());
    let mut samples = BufWriter::new(File::create(data.join("frames.csv")).map_err(io)?);
    writeln!(
        samples,
        "ms,frame,step,visible,dark,solid,since_transition_ms,black_ratio,green_ratio,capture_ms,effective_solid"
    )
    .map_err(io)?;
    let mut transitions = BufWriter::new(File::create(data.join("transitions.csv")).map_err(io)?);
    writeln!(
        transitions,
        "ms,step,action,dark,solid,call_ms,effective_solid"
    )
    .map_err(io)?;
    let args: Vec<_> = std::env::args().collect();
    let cycles = args
        .windows(2)
        .find(|p| p[0] == "--cycles")
        .and_then(|p| p[1].parse::<u32>().ok())
        .unwrap_or(120)
        .clamp(4, 2000);
    let mut app = App {
        hwnd,
        owner,
        _compositor: compositor,
        _target: target,
        root,
        clipped,
        geometry,
        glass,
        tint,
        tint_brush,
        shadow_visual,
        silhouette,
        surface,
        shadow,
        renderer,
        dpi,
        dark: system_dark(),
        solid: false,
        effective_solid: false,
        visible: false,
        ready: false,
        tracking: false,
        pressed: None,
        generation: 0,
        started,
        deadline: Instant::now(),
        last_transition: Instant::now(),
        frame_seq: 0,
        step: 0,
        cycles,
        stress: false,
        auto: args.iter().any(|a| a == "--auto"),
        capture: args.iter().any(|a| a == "--sample"),
        exit_after: args.iter().any(|a| a == "--exit"),
        saved_modes: 0,
        samples,
        transitions,
        sampler: None,
    };
    // theme() performs initial DPI layout and prepares both cached themes.
    app.theme()?;
    app.ready = true;
    APP.with(|slot| *slot.borrow_mut() = Some(app));
    let _ = ShowWindow(owner, SW_SHOWDEFAULT);
    let _ = ShowWindow(owner, SW_SHOW);
    let _ = SetForegroundWindow(owner);
    if args.iter().any(|a| a == "--auto") {
        SetTimer(Some(owner), 1, 16, None);
    }
    log(format!(
        "native_ready_ms={:.3} dpi={dpi}; Direct2D/DirectWrite + Composition; no WebView",
        started.elapsed().as_secs_f64() * 1000.
    ));
    let mut msg = MSG::default();
    while GetMessageW(&mut msg, None, 0, 0).as_bool() {
        let _ = TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    APP.with(|slot| {
        if let Some(mut a) = slot.borrow_mut().take() {
            let _ = a.close();
            a.samples.flush().ok();
            a.transitions.flush().ok();
        }
    });
    Ok(())
}
fn main() {
    let explicit = std::env::args()
        .skip_while(|s| s != "--data-dir")
        .nth(1)
        .map(PathBuf::from);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let data = explicit.or_else(|| {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|p| {
                p.join("CompositionMenuPrototype/work/runs")
                    .join(format!("{now}-{}-native", std::process::id()))
            })
    });
    let Some(data) = data else { return };
    if !data.is_absolute() {
        return;
    }
    if std::fs::create_dir_all(&data).is_err() {
        return;
    }
    let _=std::fs::write(data.join("manifest.json"),format!("{{\"owner\":\"Codex\",\"task\":\"native composition menu run\",\"createdAtUnix\":{now},\"expiresAtUnix\":{},\"preserveReason\":\"retain useful manual evidence; no browser profile is created\"}}",now+14*86400));
    DATA.with(|d| *d.borrow_mut() = data.clone());
    if let Err(e) = unsafe { run(data) } {
        log(format!("FATAL native renderer: {e}"));
        unsafe {
            MessageBoxW(
                None,
                &HSTRING::from(format!("Native menu initialization failed: {e}")),
                w!("Composition Menu Prototype"),
                MB_OK | MB_ICONERROR,
            );
        }
    }
}
