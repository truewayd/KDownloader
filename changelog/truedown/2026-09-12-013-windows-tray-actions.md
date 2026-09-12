# TrueDown Windows tray actions

- Left-click opens the main window; left double-click opens the singleton new-task form with its retained draft.
- Right-click opens the native tray menu. Left-click no longer opens that menu.
- Ignore the final left release so a double-click cannot return focus to main after opening the task form.
- Keep other platforms' tray behavior unchanged.

## Verification

- Rust event-sequence tests cover single/double clicks, release handling and other mouse buttons.
