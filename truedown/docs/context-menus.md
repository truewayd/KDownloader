# Desktop context menus

## Decision

TrueDown uses Tauri's Rust native menu API for content-area context menus.
The operating system owns the popup surface outside the document. Seven small
menu models are created once during shell setup, before showing the main window,
and reused by all four existing window roles. No extra WebView, rendering loop,
background task poller, window capability, or frontend menu library is needed.

A warmed WebView popup would allow exact CSS styling, but would also need its
own readiness handshake, focus and activation policy, DPI conversion, monitor
fitting, dismissal, accessibility tree, and lifetime management. Native menus
provide those platform behaviors without another browser surface. The choice
prioritizes native behavior and low per-open work over identical pixel styling
across Windows, macOS, and Linux. This is an architectural cost reduction, not a
measured latency claim.

## Interaction and appearance

| Context | Menu |
| --- | --- |
| Main task row | Details; pause / resume / retry; open file / folder; remove |
| Main workspace | New download, batch download; settings |
| Editable text | Cut and copy when selected, paste, select all |
| Password | Paste and select all, never cut or copy |
| Read-only or selected page text | Copy and select all |
| Contenteditable | Same editing actions as ordinary text |
| Auxiliary blank area or disabled control | No browser menu |
| Title strip | Existing native window system menu |

Native fonts, focus/selection treatment, disabled text, sizing, and system menu
theme are used. Destructive removal occupies its own final group; it delegates
to the existing task action and confirmation behavior. Rows retain a stable
menu order with unavailable actions disabled, avoiding a shifting target.
No custom animation, corner treatment, gradient, or decorative icon is added.
Menu theme follows the platform; it is not forced to match a CSS color scheme.
Undo and redo use native predefined items on macOS only, the platform documented
as supported by the pinned Tauri API. Existing keyboard editing remains intact.
Email/number controls do not expose selection ranges, so their native editor
decides whether cut/copy can act.

Right click, the Context Menu key, and Shift+F10 open the same native menu.
Keyboard invocation anchors to the focused control. Coordinates are logical
client pixels, clamped in both JS and Rust; the native backend handles DPI and
popup placement. The OS owns arrow navigation, Escape, outside click and focus
behavior. Menus operate on the clicked row without changing batch selection.
Browser fixtures without a native bridge retain their browser behavior.

## Ownership and authority

`commands::show_context_menu` accepts only a fixed menu kind, a bounded token,
bounded logical coordinates and a bounded list of action enums. Menu text and
structure live in Rust. Caller window identity comes from Tauri, not JS. Only
the main window can request task/workspace menus; unknown roles are rejected.
No direct menu/tray, clipboard-read, or window-mutation capability is granted.

A native opening slot bounds queued UI callbacks and remains owned through
callback completion if its IPC receiver is cancelled. Native setup, item state
changes and popup display are serialized on the UI thread. Hidden acceptance
rejects display; production also checks that the owner is visible and focused.
Linux's native popup call may return before dismissal; the OS retains the menu.

Native action events target only the originating window and include its request
token. The frontend rejects replaced contexts and route changes, verifies the
original row is still connected, and checks the current action is enabled before
clicking the existing control. Polling updates cannot authorize a removed or
disabled action. Page teardown removes listeners, including in-flight native
subscriptions through the shared subscription helper. Editing uses predefined
native commands and never sends selected text or clipboard content over IPC.

## Validation

- `cargo test --locked`: request bounds and role/action authorization plus the
  existing native suite.
- `npm run test:context-menu`: headless browser behavior with an explicit native
  bridge fixture; editing context, password handling, task state changes, stale
  tokens/routes, keyboard invocation, auxiliary roles and teardown.
- `npm run test:windows`: actual hidden WebView2 startup, new command registration,
  hidden-display rejection, invalid actions and cross-role rejection, alongside
  the existing window acceptance suite.

Hidden tests do not prove popup pixels, native keyboard editing delivery, or
visible focus composition. Interactive native menu appearance and editing on
Windows/macOS/Linux remain platform acceptance items; no visual or latency result
is inferred from a DOM fixture or from hidden-window checks.

Local Windows validation on 2026-09-20 passed: 33 Rust tests, 347 JS tests
(one skipped), 13 Python migration tests, Go tests and vet, shared UI verification,
extension build, context-menu browser acceptance, workspace and task-form browser
acceptance, and actual hidden WebView2 acceptance. The latter used the newly
built `target/debug/truedown-desktop.exe` explicitly; a plain Cargo build does not
replace the older Tauri-packaged `TrueDown.exe`. Linux/macOS native acceptance
was not run locally; the browser fixture is included in native CI.
