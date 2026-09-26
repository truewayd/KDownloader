# Sidebar update status and navigation highlights

- Replace the main sidebar Exit action with a compact update notice. Exit remains
  in the native tray. Show updater-owned progress independently of task filters,
  with pause, verification, restart and recoverable error states.
- Keep notice text on one line and show circular download progress. Collapsed
  sidebars retain only the progress ring; hover text exposes transfer details.
- Use neutral icon highlights while preserving the theme-colored selection
  marker on the left of the active navigation item.
- Add the settings search icon and keep search icons above input surfaces.
- Preserve Windows scheduled checks, verified downloads and idle update behavior;
  reuse native confirmation for manual restart and suspend UI polling while hidden.
- Wait for settings scripts to initialize before checking native group-editor
  focus during Windows acceptance, retaining the original bounded deadline.

## Verification

- Repository Node tests, shared UI mirror check, Go tests/vet and Rust tests.
- Light/dark workspace, settings, file-group and update-notice browser acceptance.
- WSL/Linux integration and startup smoke checks.
