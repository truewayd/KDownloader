# Project dialogs and context menus

TrueDown uses operating-system confirmations and independent native windows for
large forms. Compact input/icon pickers, Toasts and content-area menus retain the
project surface. System caption menus, tray menus and file/directory pickers are OS-owned.

## Dialogs

`confirmAction` uses `commands::confirm_action` in desktop windows. Rust validates
the caller role, bounded text, distinct button labels and an explicit info/warning/error
kind. The OS dialog is parented to the caller. One callback-owned slot per window
prevents duplicates even when the originating IPC is cancelled. A failed request
shows an error Toast and cancels the operation; it never falls back to a page modal.
Hidden acceptance suppresses native prompts without approving operations.

`showDialog` remains available for compact input prompts and browser fixtures,
with inert background roots, keyboard focus trapping, cancellation and focus restoration.
Large new-download forms, settings and task details use independent native windows
with meaningful captions; Windows/macOS title strips include decorative role icons.

## Menus

`web/context-menu.js` renders a single menu with native buttons and menu semantics.
The surface uses the top layer where available, with a fixed-position fallback
for older WebViews. Menus inside dialogs share that dialog's focus scope.

| Context | Actions |
| --- | --- |
| Main task row | Currently enabled details, pause/resume/retry, open and remove actions |
| Main workspace | New download, settings |
| Editable text | Undo, redo, cut/copy when selected, paste, select all |
| Password | Undo, redo, paste, select all; never cut/copy |
| Read-only text | Copy, select all |
| Selected page text | Copy, select all |
| Auxiliary blank area / disabled control | No content menu |
| Title strip / tray | Existing native system menu |

Right click, Context Menu and Shift+F10 open the menu. Arrow keys and Home/End
navigate; Enter/Space activate. Escape dismisses only the menu and restores focus;
Tab dismisses and continues normal focus navigation. Outside click, scroll,
resize, window blur, hiding, navigation and teardown invalidate the menu.
Coordinates remain inside the viewport. Task menus revalidate the original row
and currently enabled action before clicking the existing task control.
Opening a menu never changes task batch selection.

Editing restores the original input range or document selection first.
`commands::edit_action` accepts only a fixed enum and derives the window role from
the caller. It dispatches native editing on the UI thread only while that window
is visible and focused; Windows also verifies the foreground HWND. Cancelled
queued requests do not dispatch. Hidden native acceptance suppresses editing.
No selected text or clipboard contents cross IPC, and no clipboard-read or
menu/tray mutation capability is granted to the WebView.

## Validation

- `npm run test:context-menu`: light/dark styles, editing ranges, password
  restrictions, changing task actions, keyboard operation, viewport placement,
  modal scope, roles and teardown.
- `npm run test:forms`: native confirmation dispatch, cancellation and retained drafts.
- `npm run test:details`: native close shortcuts, no duplicate Close control,
  retained tabs/drafts and responsive layout.
- `cargo test --locked`: editor action allowlist and caller roles.
- `npm run test:windows`: hidden WebView2 command registration and suppression,
  project confirmations and the existing native lifecycle suite.

Browser fixtures validate frontend rendering and routing. Hidden native checks
do not establish visible OS composition or native keyboard/clipboard delivery.
Windows, macOS and Linux editor delivery remains a platform-specific check.
