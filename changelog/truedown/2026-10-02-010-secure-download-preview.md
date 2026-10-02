# TrueDown download preview

## Changes

- Open completed downloads in a resizable native preview window with a Mica canvas, responsive toolbar, image fit/actual-size/zoom, native media controls and literal text display.
- Add explicit Open file, Windows Open with and Open directory actions; the Windows chooser retains the existing guarded native-helper boundary.
- Give preview its own minimal capability and current-task-only IPC. Block active documents, arbitrary paths, linked files, external navigation and new WebViews.
- Validate media signatures, image dimensions/container budgets, bounded chunks and full SHA-256 before rendering. Release media and blob URLs on hide, target change and teardown.

## Verification

- Go tests passed for task/path bounds, links, oversized files, changed data, signatures, image/animation budgets and digest integrity.
- Browser checks passed for responsive fit/zoom, text injection, tampered chunks, external-network blocking, stale targets and cleanup.
- Rust permissions tests and Windows hidden native preview/hide/reopen/permission acceptance passed.
- See `truedown/docs/preview-security.md` for supported formats, limits and residual OS/WebView decoder risks. Visible Open with selection is not established by hidden tests.
