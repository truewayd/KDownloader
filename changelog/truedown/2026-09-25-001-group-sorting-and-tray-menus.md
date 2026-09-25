# TrueDown: group sorting and native menus

- Right-clicking a file group selects it before displaying its actions; removed the redundant show-group item.
- Sidebar groups can be reordered by dragging or Alt+Up/Down, with revision-checked persistence, conflict recovery and retained settings drafts.
- Removed accidental navigation/icon dragging and prevented internal drags from becoming download imports.
- Caption right-click opens the genuine Windows system menu at the pointer instead of the Alt+Space anchor.
- Tray menus contain only New, Open, Settings and Exit. Windows shares the project HMENU visuals without showing the main window; macOS and Linux use their native tray menus.

## Verification

- Go tests and vet; Rust native and dependency tests.
- Full JavaScript suite (366 passed, one platform skip), 13 Python migration tests, UI mirror check and clean extension build.
- WSL Linux core test suite and startup/download-service smoke test.
- Browser coverage for group selection, sorting, settings drafts, light/dark layouts, task forms and workspace navigation.
- Windows hidden native acceptance, including the reorder route and rejection of definition writes from the main window.
- Visible system/tray menu composition and macOS native behavior remain for manual/platform acceptance.
