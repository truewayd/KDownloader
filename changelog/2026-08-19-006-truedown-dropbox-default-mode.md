# TrueDown configurable Dropbox default mode

- Added a persisted Dropbox directory default to TrueDown's general settings, with direct archive and expanded independent-task choices.
- New dashboard tasks now initialize the per-task Dropbox selector from the saved default instead of always returning to direct archive mode.
- Applied the same default to AB-compatible browser integration and start-API requests that do not explicitly provide Dropbox module options; explicit request choices still take precedence.
- Kept the existing direct-archive behavior as the migration default for older `truedown.download-rules.json` files.
- Made filter-only settings posts from older KDownloader clients preserve TrueDown's independently selected Dropbox mode.
- Added persistence, compatibility, invalid-mode, default-routing, and dashboard wiring coverage.

## Verification

- `go test ./...`
- `go vet ./...`
- `npm test`
- `pwsh -NoProfile -ExecutionPolicy Bypass -File build.ps1`
