# TrueDown Dropbox folder parser

- Added a pure-HTTP Dropbox folder component that recursively expands public `/scl/fo/` links into independent file tasks without Chrome automation or a Dropbox Developer API token.
- Updated the private web protocol adapter for current SCL links by deriving `secure_hash` from the URL, establishing the anonymous CSRF session, and following signed continuation vouchers.
- Preserved the shared directory hierarchy under the selected download folder and bounded pages, directories, depth, response size, and total files.
- Added the same default-off project-file choices to the TrueDown dashboard and a default-on KDownloader option that synchronizes filter changes through the dedicated API-Key-protected `/settings/download-rules` path. TrueDown persists the rules and remains the only component that enforces them while parsing Dropbox; ordinary task requests no longer repeat filter configuration.
- Made every expanded file independently resumable through its stable `dl=1` link, persisted name/size/hash identity, aria2 `.aria2` control file, and fresh redirect on each admission.
- Kept Dropbox parsing, metadata probes, and aria2 transfers on the configured system proxy without launching a browser.

## Verification

- `npm test`
- `python -m unittest tests/migrate_history_json_test.py`
- `go test ./...`
- `go vet ./...`
- `pwsh -NoProfile -ExecutionPolicy Bypass -File build.ps1`
- Live opt-in Dropbox protocol and Range-resume probe through `TRUEDOWN_DROPBOX_TEST_URL`
