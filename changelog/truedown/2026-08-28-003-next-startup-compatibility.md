# Aria2 Next startup compatibility

- Restored startup compatibility with an already installed Aria2 Next 2.5.6 by withholding unsupported state and resume options while retaining integrity checks.
- Gated NEXT capabilities independently: tracker research and one-second BitTorrent resume saves start with official v2.5.7, using its legacy `bt-session-state-file` to keep all torrent state under TrueDown's private data directory; v2.6.0 and newer use the unified `state-dir`.
- Added an automatic current-process fallback to the packaged stable aria2 when a selected Aria2 Next executable cannot start; the saved preference remains unchanged and the dashboard reports the failure.
- Cleaned up failed aria2 startup processes before retrying so database and log handles do not block the fallback.
- Stopped persisting the zero `lastCheckedAt` timestamp in update settings.
- Exposed the active engine, engine version, required tracker RPC, and official minimum compatible NEXT version in tracker-research status.
- Blocked the research toggle when the active engine cannot support it and replaced the misleading “select NEXT” message with an actionable NEXT update-and-restart instruction.

## Verification

- `go test ./internal/downloader ./internal/systemupdate`
- `go test ./...`
- `go vet ./...`
- `node --check truedown/web/app.js`
