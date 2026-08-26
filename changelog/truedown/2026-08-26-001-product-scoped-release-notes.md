# Product-scoped TrueDown release notes

- Restricted TrueDown publishing to TrueDown changelog changes and TrueDown runtime paths, preventing its notes from being reused by the KDownloader release workflow.
- Made release-note selection explicitly choose the TrueDown note stream while retaining the dated changelog requirement.
- Added regression coverage for workflow routing and cross-product note isolation.

## Verification

- `node --test tests/releaseWorkflow.test.mjs`
- `go test ./...`
- `go vet ./...`
- `pwsh -NoProfile -ExecutionPolicy Bypass -File tools/read-latest-changelog.ps1 -Product TrueDown -OutputFile release-notes.md`
