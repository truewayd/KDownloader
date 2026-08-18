# TrueDown task search and custom dialogs

- Added server-side task search across file names and download links, compatible with status filters and pagination.
- Completed-task removal now runs without confirmation while preserving downloaded files.
- Replaced browser confirmation and API Key prompts with one keyboard-accessible custom modal.

## Verification

- `go test ./...`
- `go vet ./...`
- `npm test`
