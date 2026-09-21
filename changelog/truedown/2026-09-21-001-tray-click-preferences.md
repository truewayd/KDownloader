# TrueDown tray click preferences

- Windows: configure left single-click and double-click independently in Settings > Application and connections. Actions include opening the main window, creating a download, opening settings, and doing nothing.
- Windows single clicks wait for the system double-click interval. A double click cancels the pending single action, and its final release cannot steal window focus.
- macOS: configure left single-click, including the default native menu. Tauri does not emit double-click events on macOS.
- Linux: retain the native tray menu and explain that the current AppIndicator backend does not emit click events; unsupported controls remain hidden.
- Store Windows and macOS preferences independently in the profile configuration directory and apply successful saves immediately. Failed saves retain the previous behavior.

Platform reference: https://docs.rs/tauri/2.11.5/tauri/tray/enum.TrayIconEvent.html

## Verification

- Rust tests cover platform event routing, single/double-click separation, and bounded per-platform persistence.
- Native acceptance checks command permissions, platform capabilities, and persistence failure rollback.
- Responsive settings tests cover supported controls, light/dark themes, drafts, and save/failure feedback.
