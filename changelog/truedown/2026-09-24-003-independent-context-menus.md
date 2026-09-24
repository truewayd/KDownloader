# Independent context menu windows

- Desktop task, workspace and editing menus now open in separate caller-owned frameless WebViews, with project icons, shortcut hints and monitor work-area positioning.
- Native IPC allows only the offered fixed actions. Menus close on Escape, focus loss, parent movement/resizing, hiding and navigation; task actions and editing selections are revalidated in the caller.
- Browser previews retain page menus, while native failures fail closed. Tray and title-strip OS menus remain unchanged.

## Verification

- Rust role/action/coordinate validation tests and browser menu interaction tests.
- Windows visible popup acceptance verifies separate menu HWND ownership, no menu in the caller DOM, denied privileged commands, selection restoration and Escape dismissal, with screenshots.
- Native editing acceptance drivers target the independent popup for clipboard and editor operations.
