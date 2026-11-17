# Complete desktop application log permissions

- Permit application log enable, disable and clear operations from the settings window. The shared transport already accepted these requests, but the per-window allowlist still blocked them.
- Preserve denial from main, new-task, task-details, preview and confirmation windows.
- Add native permission/transport regression coverage and real Windows WebView-to-core enable/read/clear/disable smoke checks.

## Verification

- Rust permission tests run in native CI alongside real packaged Windows smoke checks.
- Local Go application log and protocol tests pass; native compilation requires MSVC, unavailable in this environment.
