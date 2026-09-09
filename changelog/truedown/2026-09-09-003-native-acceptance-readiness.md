# TrueDown - Native acceptance readiness

- Fix Windows native acceptance on elevated CI runners with WebView2 150 or
  newer. Debug builds pass a validated test port through the native WebView2
  API; the hook is absent from release builds. Hidden window, update and
  explicitly opted-in caption fixtures use the same path.
- Check release packages through the frontend health acknowledgment and native
  window visibility, without requiring a remote debugging port.
- Fix a WebKit toast observation race: flush layout before checking animation
  state, reject intermediate transforms and opacity, and assert the bounds from
  that same observation. Linux, Windows and Chromium share the check, retaining
  caption clearance, centering and long-message overflow assertions.
- Add regressions for pending WebKit animations, invisible or clipped toasts,
  and invalid debug ports. Product version remains 1.6.3.

## Verification

- Focused toast regressions and real Linux WebKitGTK acceptance inside Xvfb.
- Chromium workspace, task-form, file-group and auxiliary UI acceptance in
  light/dark themes, mobile widths and high-DPI layouts.
- Full Node suite (315 tests), Python migration suite (13 tests), shared UI and
  icon checks, extension build, Go tests and vet.
- Windows Rust formatting, Clippy and tests; Linux Rust tests and the optimized
  GLib/URLPattern regressions.
- Windows debug and release builds, hidden WebView2 acceptance with the legacy
  debugging environment variable cleared, and debug/release package startup.
  The release binary contains no test debug-port hook.
- Hidden Windows manual/automatic update, failed-health rollback and interrupted
  update rollback, including complete file sets and preserved engine binaries.
- macOS and visible native caption composition were not rerun locally.
