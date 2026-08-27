# Global download speed limit

- Added a persisted dashboard setting for the aggregate speed limit across all downloads.
- Applied the limit through aria2's native `max-overall-download-limit` global option immediately and at startup; TrueDown does not implement a separate traffic shaper.
- Preserved the configured limit when an older dashboard client updates only the simultaneous-download count.
- Reserved TrueDown-owned aria2 global options so per-task advanced arguments cannot override them.

## Verification

- `go test ./internal/downloader ./internal/api`
- `go test ./...`
- `go vet ./...`
