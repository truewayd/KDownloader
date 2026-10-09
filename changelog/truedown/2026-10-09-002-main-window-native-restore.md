# Main window native restore candidate

- Reuse the retained-WebView native-shell renewal path for ordinary hidden main windows. Keep minimized and maximized windows on their existing native restore path.
- Preserve native resize/maximize capabilities and role icons when renewing shells.
- Avoid repeated minimum-size writes and finish shell geometry before restoring Mica. Skip unchanged Mica/theme attribute writes on focus.
- Keep Windows responsible for all window appearance transitions. The isolated test build was accepted by the user.

## Verification

- Rust formatting, Clippy and native unit tests pass.
- Visible compositor acceptance remains an explicit, isolated test.
