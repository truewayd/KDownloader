# TrueDown reliability and security audit

- Closed the API-key coverage gap for resolver-module endpoints and tightened API token, redirect, archive, tracker-query, and unknown-JSON validation.
- Centralized bounded regular-file reads and crash-recoverable atomic writes for configuration, resolver packages, tracker state, authentication, and updater metadata, including symlink and interrupted-write defenses.
- Fixed duplicate-task persistence races, whitespace-folder resolution, updater-launch concurrency, shutdown cancellation, process-handle cleanup, and unbounded resolver or updater waits.
- Reduced steady-state allocation and retention with reusable persistence timers, direct byte decoders, bounded tracker maps, stale tracker restoration, HTTP idle-connection cleanup, and cancellable module preparation.
- Protected TrueDown builds and release-note selection from reparse-point traversal and pinned release automation to immutable, tested revisions.

## Verification

- `go test ./...`
- `go test -race ./...`
- `go vet ./...`
- `pwsh -NoProfile -ExecutionPolicy Bypass -File truedown/build.ps1`
- `pwsh -NoProfile -ExecutionPolicy Bypass -File tools/read-latest-changelog.ps1 -Product TrueDown -OutputFile release-notes.md`
