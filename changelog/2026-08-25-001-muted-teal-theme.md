# Muted teal theme

- Rebased KDownloader and TrueDown on `#487A7A` as the shared brand color in both light and dark modes.
- Retuned surfaces, borders, text, icons, focus rings, hover states, and shadows around a restrained gray-teal palette while preserving distinct success, warning, and error semantics.
- Updated the KDownloader extension icons and both product SVG marks to match the new palette.
- Added UI consistency coverage to keep the extension, injected controls, and TrueDown dashboard aligned with the shared brand color.

## Verification

- `npm test`
- `python -m unittest tests/migrate_history_json_test.py`
- `pwsh -NoProfile -ExecutionPolicy Bypass -File tools/build-extension.ps1`
- `pwsh -NoProfile -ExecutionPolicy Bypass -File tools/read-latest-changelog.ps1 -OutputFile release-notes.md`
- `go test ./...`
- `go vet ./...`
