# TrueDown - native auxiliary-window transitions and Mica retention

- Reopen hidden settings, new-task and task-details with a fresh native shell while retaining the WebView, draft and role identity. Windows supplies the native opening and closing transitions.
- Restore Mica and caption color before showing the replacement HWND, including accessibility-driven solid fallback. Preserve measured client size and native icons.
- Retain the document if shell setup fails so a later open can retry attachment. Keep the main-window, native-menu and non-Windows lifecycles unchanged.
- Add explicit visible compositor capture and native state checks; keep default native acceptance hidden.

## Verification

- Windows debug desktop build and 44 Rust tests.
- Native appearance JavaScript tests and hidden Windows desktop acceptance.
- Visible reopen checks cover retained documents/drafts, native DWM material, caption clipping, role icons and client dimensions. Screen recordings are separate visual evidence, not inferred from hidden tests.
