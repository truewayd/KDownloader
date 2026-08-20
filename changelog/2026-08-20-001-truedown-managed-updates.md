# TrueDown managed program and download-engine updates

- Kept aria2 1.37.0 as the stable download engine included in every TrueDown Windows package; program self-updates do not replace it.
- Added explicit, separate dashboard actions to manually install or update Aria2 Next and to select or leave it. Installing NEXT never changes the engine preference, NEXT is never checked or updated in the background, and switching engines requires a normal TrueDown restart.
- Restricted NEXT downloads to stable `AnInsomniacy/aria2-next` GitHub Release assets for the running Windows architecture, with published SHA-256 and executable-version verification before activation metadata is persisted.
- Added automatic TrueDown release checks, verified staging, and idle-only restart behavior. Numbered release builds validate a build-matched manifest, archive size, and SHA-256 before extracting only `TrueDown.exe`.
- Added an external update helper that waits for TrueDown and aria2 to exit, keeps the previous executable, verifies startup with a per-update health token, and automatically rolls back a failed replacement.
- Added authenticated system-update and engine-management APIs plus dashboard status, warnings, opt-in controls, progress states, and manual actions.
- Updated the TrueDown build and release workflow to clean a bounded package target, inject version/build/commit metadata, include aria2's GPL text, publish a machine-readable update manifest, and use the dated project changelog for release notes.

## Verification

- `node --check truedown/web/app.js`
- `go test ./...`
- `go vet ./...`
- `pwsh -NoProfile -ExecutionPolicy Bypass -File truedown/build.ps1`
