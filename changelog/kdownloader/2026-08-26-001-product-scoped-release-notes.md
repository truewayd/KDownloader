# Product-scoped KDownloader release notes

- Restricted extension publishing to KDownloader changelog changes and extension runtime paths, so TrueDown-only work cannot create a KDownloader release.
- Made release-note selection explicitly choose the KDownloader note stream while retaining the dated changelog requirement.
- Added regression coverage for workflow routing and cross-product note isolation.

## Verification

- `node --test tests/releaseWorkflow.test.mjs`
- `npm test`
- `pwsh -NoProfile -ExecutionPolicy Bypass -File tools/build-extension.ps1`
- `pwsh -NoProfile -ExecutionPolicy Bypass -File tools/read-latest-changelog.ps1 -Product KDownloader -OutputFile release-notes.md`
