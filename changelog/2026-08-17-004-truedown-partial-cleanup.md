# Clean up removed partial downloads

- Preserve completed files when their TrueDown task records are removed.
- Stop active aria2 tasks and remove their partial data and `.aria2` control files before deleting their records.
- Recheck aria2 state before cleanup and validate recorded paths as direct children of the task download directory to avoid deleting completed or unrelated files.

## Verification

- `go test ./...`
- `go vet ./...`
