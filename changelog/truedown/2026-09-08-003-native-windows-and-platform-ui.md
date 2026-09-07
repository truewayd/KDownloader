# TrueDown: native windows and platform UI

- Add a Tauri shell with bundled assets, per-profile single-instance handling,
  native tray and protected clipboard operations.
- Open settings, application logs and about in separate singleton windows. Retain
  setting drafts on close, add keyboard shortcuts and preserve reachable save bars.
- Add Windows Fluent and macOS visual adaptations with native frame materials and
  opaque fallbacks. Keep the existing browser dashboard and shared components.
- Select exact tray-icon rasters for the Windows taskbar monitor's DPI.
- Add profile-scoped, opt-in login startup with argument quoting, owner checks and
  Windows system-disable reporting; use XDG autostart on Linux and LaunchAgents on macOS.

## Verification

- Rust tests and Clippy with warnings denied; Windows debug Tauri build.
- Windows WebView2 acceptance with every window hidden: window reuse, shared settings,
  retained drafts, credential isolation, contrast fallback, scaled layouts and exit.
- Exact icon dimensions for 100%, 125%, 150%, 200%, 250%, 300% and 400% scaling.
- Shared component consistency tests. Native macOS/Linux runtime checks and complete
  bundle release/update transactions remain part of the ongoing migration.
