# Security, quality, and hot-path audit

- Reduced extension permissions and constrained supported sites to HTTPS, while removing unused RPCs, constants, startup work, and exports.
- Added strict validation and size, timeout, redirect, origin, header, and URL boundaries across settings, downloads, Gist, creator cache, Pawchive bridges, Watch imports, and native fallback state.
- Restricted backend cookie forwarding to matching site families, rejected untrusted media URLs, and correlated concurrent download progress with request IDs.
- Bounded Watch concurrency and in-memory reports, cached active history generations, and reclaimed retired or abandoned IndexedDB generations.
- Hardened TrueDown with loopback-only defaults, explicit remote opt-in, Host and Origin checks, security headers, request limits, safe task snapshots, strict download options, and faster GID status lookup.
- Improved Creator Fetch failure handling, hidden-tab polling, duplicate rendering, localized status text, and accessibility-oriented state updates.

## Verification

- `npm test`
- `python -m unittest tests/migrate_history_json_test.py`
- `pwsh -NoProfile -ExecutionPolicy Bypass -File tools/build-extension.ps1`
- `pwsh -NoProfile -ExecutionPolicy Bypass -File tools/read-latest-changelog.ps1 -OutputFile release-notes.md`
- `go test ./...`
- `go vet ./...`
- `pwsh -NoProfile -ExecutionPolicy Bypass -File truedown/build.ps1`
