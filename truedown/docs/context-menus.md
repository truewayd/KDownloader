# Project dialogs and context menus

TrueDown uses independent project-themed confirmation windows and native windows for
large forms. Compact input/icon pickers, Toasts and content-area menus retain the
project surface. System caption menus, tray menus and file/directory pickers are OS-owned.

## Dialogs

`confirmAction` opens an independent, caller-owned WebView window through
`commands::confirm_action` for information, warnings and dangerous actions, including
Restore defaults, task deletion and draft replacement. It uses `confirmation.html`
with project styling rather than an OS message box or a modal inside the parent page.
Rust validates the role, bounded text, distinct labels and info/warning/error kind.
The parent is disabled until the popup is destroyed. Each invocation has a unique
window label; one slot per caller remains held through native cleanup. Popup IPC is
limited to initializing, showing and answering its own request, with no core access.
Escape, close, caller hiding/navigation, initialization timeout and cancellation
fail closed. Native failure never falls back to a page modal. Hidden acceptance
suppresses prompts without approving actions. `showDialog` is a browser-only fallback.
Large new-download forms, settings and task details use independent native windows
with meaningful captions; Windows/macOS title strips include decorative role icons.

## Menus

`web/context-menu.js` collects eligible actions and retains the caller's selection.
Desktop views invoke `show_context_menu` to create an independent frameless native
WebView (`context-menu-window.html`) owned by the caller. It renders project icons,
labels and shortcut hints and is clamped to the monitor work area, rather than the
parent WebView bounds. The parent stays enabled. A browser-only fallback retains
the page menu; native failures never fall back to it.

Rust bounds the actions, coordinates and per-caller concurrency. Each request has
a unique native window identity and caller-bound cancellation ID. The popup may
only read its own offered actions and return one of them; core access and arbitrary
menu/tray mutations remain denied. Task actions revalidate the original row and
editing restores the selection in the original caller before native dispatch.

| Context | Actions |
| --- | --- |
| Main task row | Currently enabled details, pause/resume/retry, open and remove actions |
| File-group link | View this group, adjust this group, add group, manage groups |
| Download navigation whitespace | New download, add group, manage groups |
| Task-list whitespace | New download, enabled global queue pause/resume/retry/clear actions, default download directory |
| Other sidebar whitespace | New download, manage groups, settings |
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
Mouse-opened desktop menus are non-focusable: showing, hovering and dismissing
them leaves the caller active. Caller blur cancels them without raising the caller
again. A bounded `context_menu_key` command forwards navigation and activation
from the focused caller to its own pending menu. Keyboard-opened menus may take
focus and use their existing keyboard accessibility and focus restoration.
Desktop coordinates remain inside the monitor work area. Task menus revalidate the original row
and currently enabled action before clicking the existing task control.
Opening a menu never changes task batch selection.

Group adjustment opens File management in the singleton settings window and focuses
that group's name; its existing editor also exposes icons, suffixes, output directories
and removal. `open_group_settings` is main-only and accepts a bounded group ID or an
add intent, never an arbitrary route. New-window intents arrive in the initial URL;
existing windows receive a bounded hash navigation without reloading their drafts.
The editor consumes each intent once after initialization. Missing groups report an
error rather than editing another group. Queue labels explicitly say they affect the
whole queue even when the task list is filtered. Task and group identity and enabled
controls are checked again before dispatch. Other controls receive no workspace menu.

Editing restores the original input range or document selection first.
`commands::edit_action` accepts only a fixed enum and derives the window role from
the caller. It dispatches native editing on the UI thread only while that window
is visible and focused; Windows also verifies the foreground HWND. Cancelled
queued requests do not dispatch. Hidden native acceptance suppresses editing.
No selected text or clipboard contents cross IPC, and no clipboard-read or
menu/tray mutation capability is granted to the WebView.

## Validation

### Native menu customization options (2026-09-24)

The supplied Codex screenshot is a visual reference; it cannot establish the
underlying implementation. Tauri's Rust menu builders support icons, shortcuts,
separators and submenus. Native menu construction should remain in Rust with fixed
action IDs and caller-window checks, without granting WebViews menu mutation.

Deeper Windows customization uses owner-drawn menu items (`MFT_OWNERDRAW`,
`WM_MEASUREITEM`, `WM_DRAWITEM`). This requires application handling of drawing,
DPI, high contrast, disabled/selected states and keyboard behavior; CSS cannot
style native menus. A separate popup WebView window could extend outside the
parent content, but adds focus, activation, monitor and dismissal lifecycle work.

Content menus now use separate themed native WebView windows. Keep consistent
icon/label/shortcut alignment and meaningful action groups. Add submenus only for
actual grouped actions, with arrow-key navigation and monitor-aware placement.
Title-strip and tray menus retain their existing OS implementations.

Sources: [Tauri menus](https://v2.tauri.app/learn/window-menu/),
[Microsoft owner-drawn menus](https://learn.microsoft.com/en-us/windows/win32/menurc/using-menus#creating-owner-drawn-menu-items).

### Checks

- `npm run test:context-menu`: light/dark styles, editing ranges, password
  restrictions, changing task actions, keyboard operation, viewport placement,
  modal scope, roles and teardown.
- `npm run test:forms`: independent confirmation dispatch, cancellation and retained drafts.
- `node tests/windows-popups-visual.mjs --visible`: isolated visible HWNDs, owned-window
  screenshots, parent disable/restore, confirmation results and popup IPC boundaries.
- `npm run test:details`: native close shortcuts, no duplicate Close control,
  retained tabs/drafts and responsive layout.
- `cargo test --locked`: editor action allowlist and caller roles.
- `npm run test:windows`: hidden WebView2 command registration and suppression,
  project confirmations and the existing native lifecycle suite.

Browser fixtures validate frontend rendering and routing. Hidden native checks
do not establish visible OS composition or native keyboard/clipboard delivery.
Windows, macOS and Linux editor delivery remains a platform-specific check.

The shared native editing scenario passed on Linux under WSL/Xvfb. Expanded
Windows hidden checks passed for all four window roles. Windows visible delivery
and macOS native delivery still require their platform CI runs; the hidden
Windows result does not establish clipboard delivery.

## Running native editing acceptance

## Popup preparation

`popup-preload.js` prepares a hidden native window only on a likely interaction:
right-button press for menus, or hovering a destructive/reset control for
confirmations. Rust permits one unused window per caller and kind (four caller
roles, two kinds), and expires unused windows after 60 seconds. There is no
startup-wide warmup. Each window is consumed once and destroyed on dismissal;
request identities and action permissions are never reused. Cancellation while
creation is pending is checked again before activation. Renderers load only
their small page and the shared visual baseline, with no task polling.

The explicit Windows popup fixture records request-to-ready time alongside HWND
ownership and caller modality checks. On the development machine one observed
cold confirmation took 1084 ms; two fully prepared confirmations took 79 and
178 ms. These include CDP observation overhead and are not a latency guarantee.
A quick click or keyboard request can still take the cold path.

### Editing scenario

The shared `desktop/tests/native-editing.js` scenario uses a fresh, unique text
marker for every run. It selects a substring, activates the production editing
menu in its separate WebView, and checks copy/paste, undo/redo, cut/paste and native select-all by comparing
DOM state inside the WebView. Drivers receive booleans only. A successful command
response without the expected editor change fails the check. Clipboard-read IPC
must remain denied; no permissions or production test commands are added.

Linux runs the scenario in the existing Xvfb acceptance. macOS embeds it only in
the debug acceptance fixture, under the existing native deadline. Windows keeps
`test:windows` hidden and checks suppression of every editor action in all four
window roles. The separate `node tests/windows-editing.mjs --visible` runner
requires an interactive desktop, uses the system clipboard, and closes its
isolated instance afterward. CI opts into it on the disposable Windows runner;
local runs require the explicit flag. These scenarios are wired into CI; this
does not establish a passing native delivery result on an untested platform.
