# Reliable clean retries and engine-exit reporting

- Captured aria2's validated direct-child partial path when an HTTP stale-range retry is requested, so queued clean restarts can still remove the correct partial and `.aria2` control file after the old GID result disappears.
- Detect unexpected aria2 process exits instead of repeatedly polling a dead loopback RPC port. Queued, downloading, and paused tasks now become actionable errors that ask the user to restart TrueDown.
- Blocked retries after the engine has exited and replaced the misleading partial-path cleanup failure with an engine-unavailable explanation when the old path cannot be queried.

## Verification

- `go test ./internal/downloader`
- `go test ./...`
- `go vet ./...`
