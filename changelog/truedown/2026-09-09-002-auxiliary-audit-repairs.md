# TrueDown auxiliary audit repairs

- Render custom file-group names as literal text in task rows.
- Preserve settings drafts and proxy-field visibility across category changes.
- Keep module actions busy across list refreshes and prevent overlapping actions
  for the same module.
- Report the actual OS login-startup state and its disablement reason. Propagate
  Windows approval read failures and respect macOS launchd disabled overrides.
- Refit windows when their monitor work area changes without a DPI change.
- Reject incomplete or oversized responses from an attached core before
  forwarding success status, body or response metadata. Never replay the request.
- Add Rust, Go and real-browser regressions. The detailed audit and platform
  validation limits are recorded in `truedown/docs/tauri-auxiliary-audit-2026-09-09.md`.

## Verification

- Go tests and vet passed on Windows; all 11 Linux test packages and the isolated
  core/aria2 smoke check passed under WSL.
- Browser settings, workspace, file groups and native form acceptance passed.
- Rust formatting, 24 unit tests, the dependency regression, Clippy and the full
  Node suite passed. The rebuilt Windows desktop passed hidden WebView2 window,
  recovery, pipe and core task-settings acceptance.
- The audit report records the macOS, Linux native GUI and physical multi-monitor
  validation limits.
