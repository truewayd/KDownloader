# Project dialogs and context menus

- Desktop confirmation prompts now use the same project dialog as text input prompts, including light/dark colors, danger styling, keyboard focus trapping and focus restoration. Background controls are inert until dismissal; hiding or leaving the page cancels pending confirmations.
- Task, workspace and editing context menus use the project surface, accessible menu items, keyboard navigation and viewport-aware placement. Stale or disabled task actions are checked again before execution.
- Retire the native confirmation and popup-menu IPCs. Keep only fixed native editor actions; clipboard contents are never returned through IPC. System title-bar menus, tray menus and file/directory pickers retain their OS behavior.
- Add browser coverage for selection restoration, password copy protection, stale actions, nested dialog dismissal and menu positioning.

## Verification

- Light/dark context-menu and task-form browser acceptance passed, including focus trapping, nested cancellation and fallback menu rendering.
- Rust tests and Clippy passed. Packaged Windows hidden-window acceptance passed with project confirmations and bounded native editing commands.
- Native clipboard delivery in visible windows and macOS/Linux native UI were not exercised locally.
