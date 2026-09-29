# TrueDown - aria2 NEXT 2.8.3 compatibility

- Preserve native HTTP checkpoint identity across failed retries and prevent stale terminal results from cancelling a queued retry.
- Report missing native recovery data explicitly; a user retry restarts only the owned file. Renewed resolver URLs respect NEXT's URL-bound recovery rules.
- Support capability-gated filename resolution with original header bytes, bounded RPC waits and fallback for stable and older engines.
- Run transfer and filename integration acceptance against a SHA-256-pinned NEXT 2.8.3 binary in pull-request and Windows release validation.

## Verification

- `go test ./...` and `go vet ./...`.
- Real Windows downloader acceptance with bundled stable aria2 and verified NEXT 2.8.3; NEXT filename RPC and nonzero-range retry assertions.
- WSL/Linux package tests and core smoke: SQLite, task API, single instance, engine cleanup and clean API exit.
- Shared UI mirror check, repository Node tests, 13 Python migration tests and extension packaging.
- Native desktop UI and live third-party download services were not exercised by this engine compatibility change.
