//! End the native loop before USER32 creates a selected-item fade snapshot.
//! Navigation and highlight state remain owned by HMENU; no global SPI writes.
use std::cell::Cell;
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM},
    UI::{
        Input::KeyboardAndMouse::{VK_ESCAPE, VK_RETURN, VK_SPACE},
        WindowsAndMessaging::*,
    },
};

thread_local! {
    static ACTIVE: Cell<*const State> = const { Cell::new(std::ptr::null()) };
}
struct State {
    menu: HMENU,
    owner: HWND,
    count: usize,
    visible_owner: bool,
    selected: Cell<u32>,
}
pub struct Tracking {
    state: Box<State>,
    hook: HHOOK,
}
impl Tracking {
    pub unsafe fn attach(
        menu: HMENU,
        owner: HWND,
        count: usize,
        visible_owner: bool,
    ) -> Result<Self, String> {
        if ACTIVE.with(|slot| !slot.get().is_null()) {
            return Err("Menu input tracking is already active".into());
        }
        let state = Box::new(State {
            menu,
            owner,
            count,
            visible_owner,
            selected: Cell::new(0),
        });
        let hook = SetWindowsHookExW(
            WH_MSGFILTER,
            Some(filter),
            std::ptr::null_mut(),
            GetWindowThreadProcessId(owner, std::ptr::null_mut()),
        );
        if hook.is_null() {
            return Err("Cannot install menu input tracking".into());
        }
        ACTIVE.with(|slot| slot.set(&*state));
        Ok(Self { state, hook })
    }
    pub fn selected(&self, native: u32) -> u32 {
        if self.state.selected.get() != 0 {
            self.state.selected.get()
        } else {
            native
        }
    }
}
impl Drop for Tracking {
    fn drop(&mut self) {
        unsafe {
            UnhookWindowsHookEx(self.hook);
        }
        ACTIVE.with(|slot| slot.set(std::ptr::null()));
    }
}

unsafe fn highlighted(state: &State, index: u32) -> Option<u32> {
    let mut info = MENUITEMINFOW {
        cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
        fMask: MIIM_STATE | MIIM_ID | MIIM_SUBMENU | MIIM_FTYPE,
        ..Default::default()
    };
    if GetMenuItemInfoW(state.menu, index, 1, &mut info) == 0
        || info.fState & (MFS_DISABLED | MFS_GRAYED) != 0
        || info.fState & MFS_HILITE == 0
        || info.fType & MFT_SEPARATOR != 0
        || !info.hSubMenu.is_null()
        || info.wID != index + 1
    {
        return None;
    }
    Some(info.wID)
}

unsafe extern "system" fn filter(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code == MSGF_MENU as i32 && lp != 0 {
        let consumed = ACTIVE.with(|slot| {
            let Some(state) = slot.get().as_ref() else {
                return false;
            };
            let msg = &*(lp as *const MSG);
            if msg.message == WM_MOUSEMOVE {
                super::style::record_pointer(msg.pt);
            }
            let mouse = matches!(msg.message, WM_LBUTTONUP | WM_RBUTTONUP);
            let key = msg.message == WM_KEYDOWN;
            if key && msg.wParam == VK_ESCAPE as usize {
                super::style::dismiss();
                return true;
            }
            if !mouse
                && !(key
                    && matches!(msg.wParam, value
                if value == VK_RETURN as usize || value == VK_SPACE as usize))
            {
                return false;
            }
            if GetForegroundWindow() != state.owner
                || (state.visible_owner && IsWindowVisible(state.owner) == 0)
            {
                super::style::dismiss();
                return true;
            }
            for index in 0..state.count as u32 {
                let Some(id) = highlighted(state, index) else {
                    continue;
                };
                if mouse {
                    // Use the native row's screen rectangle, never a parallel
                    // CSS rectangle or a row-height approximation.
                    let mut row = RECT::default();
                    if GetMenuItemRect(std::ptr::null_mut(), state.menu, index, &mut row) == 0
                        || msg.pt.x < row.left
                        || msg.pt.x >= row.right
                        || msg.pt.y < row.top
                        || msg.pt.y >= row.bottom
                    {
                        continue;
                    }
                }
                state.selected.set(id);
                super::style::dismiss();
                return true;
            }
            // Empty-space clicks still follow native cancellation behavior.
            false
        });
        if consumed {
            return 1;
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, wp, lp)
}
