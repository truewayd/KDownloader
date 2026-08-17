# Fix removal of queued TrueDown tasks

- Preserve structured aria2 JSON-RPC errors returned with HTTP 400 responses.
- Treat a queued task whose GID has not reached aria2 yet as already stopped, allowing its TrueDown record to be removed without showing a misleading HTTP 400 failure.

## Verification

- `go test ./...`
- `go vet ./...`
