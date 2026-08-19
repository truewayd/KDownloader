# KDownloader and TrueDown runtime quality audit

- Removed repeated selector construction from KDownloader's host-page mutation observer while preserving the shared idempotent route watcher.
- Bounded TrueDown dashboard ETag and task-status caches, cleaned up temporary file-picker listeners, and kept unsaved settings resets isolated from live defaults.
- Added revision-first conditional task-page responses so unchanged searched or sorted pages return without rebuilding and sorting the full result set.
- Added linear ID/status paging and allocation-free common ASCII search/sort comparisons; a 10,000-task unchanged sorted-page check now completes in roughly 0.4 microseconds with 32 bytes allocated in the local benchmark.
- Stopped status persistence snapshots from cloning credential headers and aria2 argument slices on every polling update.
- Moved resolver component file I/O outside the active registry read lock, serialized mutations separately, and made enablement settings bounded and backup-recoverable.
- Streamed and bounded Dropbox folder JSON entries, bounded Google Drive folder parsing, cancelled sibling requests after errors, and reduced large HTML parsing intermediates.
- Tightened declarative component paths and request identity header values against traversal segments and control characters.
- Added focused ordering, conditional-response, cache, settings, component recovery, response-boundary, and allocation benchmark coverage.

## Verification

- `npm test`
- `python -m unittest tests/migrate_history_json_test.py`
- `go test ./...`
- `go vet ./...`
- `pwsh -NoProfile -ExecutionPolicy Bypass -File tools/build-extension.ps1`
- `pwsh -NoProfile -ExecutionPolicy Bypass -File truedown/build.ps1`
