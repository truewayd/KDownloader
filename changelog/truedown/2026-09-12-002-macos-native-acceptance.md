# TrueDown - Bounded macOS native acceptance

- Add macOS native acceptance to the existing desktop CI matrix, with a five-minute outer timeout and retained failure diagnostics.
- Use an explicitly enabled, debug-only fixed fixture with public Tauri APIs to verify background launch, native close-to-hide, singleton windows, and retained settings and single/batch task-form drafts. No private inspector or new WebView permissions are required.
- Bound serial readiness checks, reject stale JavaScript completions, verify the core survives hidden windows, and require graceful desktop/core exit. Verify profile identity before requesting shutdown, reuse Unix process-group cleanup, and terminate surviving descendants even after parent pipes close.

## Verification

- Native and release-workflow Node checks pass, including evaluation lifecycle and bounded cleanup unit tests. The real Unix process-group regression passes under WSL.
- Windows Rust unit tests, clippy, Rust formatting, and actionlint workflow validation pass.
- macOS native execution is delegated to the existing macos-15 CI runner; it cannot run on the Windows development host.
