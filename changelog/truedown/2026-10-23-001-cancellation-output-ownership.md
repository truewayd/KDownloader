# Preserve output ownership during cancellation

- HTTP cancellation now uses the same ownership checks as retries. Conflicting
  legacy payload/control-file reservations retain their files and task record.
- Removing a BitTorrent task stops the engine and removes its record while
  retaining single-file payloads and multi-file trees.
- Invalid stored task identities fail partial-file cleanup without deleting data.
- Regression tests cover overlapping reservations and both torrent layouts.

## Verification

- Focused cancellation/ownership regressions and Windows Go package tests.
- `go vet ./...`; Windows Go core/CLI and Linux cross-builds.
- Real stable aria2 lifecycle and NEXT 3.0.8 pause/removal integration tests.
- WSL: all 18 test binaries and the Linux core startup smoke passed.
- Node regression suite (one platform skip, corrected changelog contract rerun),
  13 Python tests, shared UI mirror check and extension build passed.
