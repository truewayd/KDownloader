# TrueDown hot-reloadable resolver components

- Split the Dropbox and Google Drive resolvers into compiled security engines and independently versioned declarative compatibility packages.
- Embedded a known-good baseline package for each resolver and added safe startup fallback when an installed update is corrupt, incompatible, or older than the current binary's baseline.
- Added bounded component import and baseline-reset APIs. Successful imports persist under the TrueDown data directory and atomically hot-swap immutable resolver snapshots without restarting or mutating in-flight work.
- Kept provider host allowlists, redirects, response limits, traversal limits, credentials, and task construction inside the compiled engine so imported packages cannot execute code or widen network access.
- Expanded the dashboard module cards with active/baseline versions, source, release date, SHA-256 identity, update errors, local package import, and accessible baseline-reset confirmation.
- Preserved independent enablement in `truedown.modules.json`; disabling a resolver still affects only new-link routing, while existing tasks use the active baseline or updated component for refresh and resume.

## Verification

- `go test ./...`
- `go vet ./...`
- `pwsh -NoProfile -ExecutionPolicy Bypass -File build.ps1`
- `npm test`
