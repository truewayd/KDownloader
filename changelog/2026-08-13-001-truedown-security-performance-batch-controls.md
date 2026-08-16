# TrueDown security, performance, and batch controls

- Reworked the TrueDown dashboard around bounded 100-task pages, ETag-aware adaptive polling, status filters, cross-page selection, and server-side batch pause, resume, retry, and task removal. Removing a task stops active aria2 work but preserves completed and partial files.
- Bounded aria2 admission to 256 queued or active tasks, reduced status polling windows, indexed output-name reservations, and moved polled SQLite writes out of the global task lock into revision-guarded transactions.
- Added optional TrueDown API-token authentication that is off by default and can be toggled from the dashboard without disconnecting its own API session. Enabled tokens persist locally, remote TLS listeners require and lock authentication on, and remote dashboards keep manually entered tokens only for the current tab.
- Moved KDownloader and Gist secrets to local-only storage with immediate legacy-sync migration, redacted content-script configuration reads, restricted secret mutations to extension pages, bounded aria2 RPC responses, and tightened request-header and aria2-option controls.
- Preserved authenticated media downloads: KDownloader continues to forward Cookie, Referer, and User-Agent only to trusted media URLs in the matching site family, and TrueDown passes those per-download headers to aria2 without exposing them in task snapshots.
- Added migration coverage, pagination/ETag tests, bounded retry-all and batch persistence tests, same-family credential-forwarding tests, authentication tests, an aria2 admission-bound test, and a 10,000-task page benchmark.

## Verification

- `npm test`
- `python -m unittest tests/migrate_history_json_test.py`
- `pwsh -NoProfile -ExecutionPolicy Bypass -File tools/build-extension.ps1`
- `pwsh -NoProfile -ExecutionPolicy Bypass -File tools/read-latest-changelog.ps1 -OutputFile release-notes.md`
- `go test ./...`
- `go vet ./...`
- `go test -run '^$' -bench BenchmarkPageTaskSnapshots100Of10000 -benchmem ./internal/downloader`
