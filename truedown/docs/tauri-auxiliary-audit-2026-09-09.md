# TrueDown auxiliary audit - 2026-09-09

Three independent audit passes covered Rust auxiliary modules, the dashboard,
and the Go desktop bridge. The parent agent reread each reported path, accepted
eight P2 findings, reviewed the repairs, and ran the combined verification.
No P1 finding was confirmed. Previously repaired A01-A13 findings from
`tauri-audit-2026-09-08.md` are excluded.

The working tree already contained the previous audit and other changes. This
pass preserved them and compared its edits with a separate starting snapshot.
Locations below describe the code at the start of this audit; repair locations
may have shifted. All listed findings are repaired in the current working tree.

## Findings, strongest first

### B01 - P2: Custom group names became task-row HTML

Original location: `web/app.js:1202`; HTML parser: `web/task-view.js:10`;
data source: `web/file-groups.js:6-9`.

A saved group name such as `<img data-audit-injected src="x">` satisfies the
server's name constraints. Opening a task in that group inserted the name
directly into a template, creating an actual image element. Other task labels
were escaped, but this group label was not. Production CSP blocks inline script
execution; the confirmed issue is persistent HTML injection and DOM alteration,
not demonstrated JavaScript execution.

Repair: escape the group label before assembling the task row. A real Chromium
fixture using the production CSP verifies that the name remains literal text and
creates no injected node.

### B02 - P2: Attached-core response truncation retained success status

Original location: `internal/app/desktop.go:131-138`, specifically `137-138`.

An independent core can return a successful task-creation status and declare
`Content-Length: 9`, then disconnect after writing only `OK 123`. The proxy wrote
the status and success headers before reading the response and ignored
`io.Copy`'s unexpected EOF. The bridge consequently returned success with a
truncated task identifier. The body-size guard did not detect this read error.

Repair: read the complete response under the existing 8 MiB bound before
forwarding status, allowed headers or body. Incomplete and oversized responses
return 502 without a partial body, ETag or duplicate marker. Requests are never
replayed. HTTP regression tests cover complete, truncated and oversized bodies,
credential-header filtering and a single mutation dispatch.

### B03 - P2: Category rendering overwrote other settings drafts

Original location: `web/settings.js:62-68` and `136-140`.

Edit the experimental minimum-Leecher field from its saved value of 3 to 77,
visit the engine category for the first time, then return. Engine initialization
called the full experimental renderer, restoring 3; the rendered-category guard
then preserved the wrong value. Separately, choosing a custom proxy and visiting
an uninitialized file category preserved the proxy value but hid its field and
removed its required constraint. Restoring only value/checked did not restore
derived state.

Repair: render only controls belonging to the requested category. Engine
initialization updates only its read-only identity text. Real-browser checks
exercise both navigation sequences and verify proxy visibility and validation.

### B04 - P2: Module redraw removed pending-operation protection

Original location: `web/settings.js:666-730` and `733-763`.

Leave a Dropbox toggle POST pending, then finish a Google Drive toggle. The
second completion rebuilt every module card, discarding the original busy
button. The new Dropbox controls were active while its first request remained
pending; clicking again sent a third POST. Import and reset controls for that
same module were also unprotected.

Repair: track pending actions by module ID across redraws and guard dispatch.
All controls for the pending module remain busy through file selection,
confirmation and mutation, while other modules remain usable. Success, failure
and cancellation release the slot. The browser fixture holds responses and
dialogs open to verify these cases and reject duplicate dispatch.

### B05 - P2: Startup feedback claimed the requested state was applied

Original location: `web/settings.js:173-194`.

When Windows Task Manager disables a registered login item, an enable POST
returns `supported:true`, `enabled:false` and an OS explanation. The UI used the
requested `true` to announce success and omitted the reason whenever supported
was true. The correctly returned OS state therefore did not protect the user
from the false success message.

Repair: render the returned state and reason, and announce successful enablement
only if the returned state matches the request. A real-browser response fixture
verifies the unchecked control, visible reason and failure feedback.

### B06 - P2: Windows approval read errors became enabled state

Original location: `desktop/src/startup.rs:195-206`.

With a matching Run registration, access denial or another failure reading
StartupApproved was converted to None by `.ok()`. The code then reported
enabled, even though it had failed to establish the authoritative OS state.
The check for disabled bytes 3/7 only guarded successful reads.

Repair: distinguish a missing entry from other read errors and check approval
before registry mutations. Error-injection tests cover access denial, absence
and both enabled/disabled byte variants without editing the user's Run entries.

### B07 - P2: macOS ignored persistent launchd disablement

Original location: `desktop/src/startup.rs:320-322`.

Disable the profile's LaunchAgent through launchd while leaving its plist
unchanged. Byte equality with the expected plist still reported enabled;
rewriting the same plist did not remove the persistent disabled override.
The override is stored separately from the plist, as described in the
[Apple launchctl manual](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchctl.1).

Repair: query the exact profile label with fixed `launchctl print-disabled`
arguments before reading or enabling registration. The existing process helper
enforces 15 seconds, 64 KiB, exit-status checking and termination on failure or
cancellation. Preserve OS disablement and explain it; do not force-enable it.
Removing an owned registration remains possible if the query is unavailable.

Parser regressions cover exact labels, absence, ambiguous or malformed output,
optional login-item associations, and both boolean and enabled/disabled formats.
The latter compatibility change is documented by the
[NIST macOS Security Compliance Project](https://github.com/usnistgov/macos_security/issues/167).
These parser/process tests do not constitute a native macOS execution test.

### B08 - P2: Same-DPI monitor moves did not refit window bounds

Original location: `desktop/src/main.rs:254-256`, calling
`desktop/src/placement.rs:22` only on scale changes.

A 1200x820 window moved from a 1920x1080 monitor to a 1280x720 monitor at the
same scale retained its old height, leaving controls below the smaller work
area. The locked Tao implementation emits Moved for that transition and does
not emit ScaleFactorChanged when the scale is unchanged. Existing creation and
show-window fits did not handle an already visible window moving monitors.

Repair: retain each window's last work-area position, size and scale; refit on
Moved only if that identity changes. Record the baseline before window changes
to avoid recursive fitting. Same-screen dragging remains under OS control.
Tests cover independent window tracking, same-area moves, same-DPI changes and
scale changes. Physical two-monitor dragging remains unverified on this host.

## Coverage and clean areas

All requested Rust files were read completely, with relevant callers and locked
dependencies checked where needed:

- `desktop/src/startup.rs`: B06 and B07; quoting, foreign-entry protection and legacy migration otherwise retained.
- `desktop/src/frame/windows.rs`: no new finding; GDI ownership and subclass lifecycle checked.
- `desktop/src/frame.rs`: no new finding; UI-thread installation and native input handling checked.
- `desktop/src/placement.rs`: B08 through its event wiring; prior role-minimum repair excluded.
- `desktop/src/pickers.rs`: no new finding; prior cancellation repair excluded.
- `desktop/src/profile.rs`: no new finding; prior bounded-probe repair excluded; helper reused by B07.
- `desktop/src/update.rs`: no new finding.
- `desktop/src/appearance.rs`: no new finding; frontend serialization and native material cleanup checked.
- `desktop/src/webview.rs`: no new finding.
- `desktop/src/tray_image.rs`: no new finding; exact icon frames and DPI selection checked.
- `desktop/src/menu_icons.rs`: no new finding.
- `desktop/src/build_info.rs`: no new finding; build-time resource assumptions checked.
- `desktop/build.rs`: no new finding; its expect is a build failure, not runtime input.

All 15 requested web files were read completely; `styles.css` was skimmed for
tokens, dark mode, focus, reduced motion and responsive layout:

- `web/app.js` and `web/settings.js`: B01 and B03-B05.
- `web/task-view.js` and `web/file-groups.js`: B01's data/rendering path; no independent additional finding.
- `web/api.js`, `task-forms.js`, `task-details.js`, `logs.js`, and `workspace.js`: no new finding in polling, ETags, text-safe logs, stale reads or lifecycle handling.
- `web/file-controls.js`, `native-windows.js`, `native-frame.js`, `native-appearance.js`, and `about.js`: no new finding.
- `web/index.html` and the reviewed `styles.css` areas: no new finding; custom modal semantics, keyboard handling and shared visual primitives checked.

Go coverage included complete `internal/desktopbridge/bridge.go` and its tests;
`internal/protocol/desktop.go`, its tests, `info.go`, and `routes.json`;
`internal/app/desktop.go`; launch source/tests including all requested desktop
flags; and Rust `desktop/src/bridge.rs` for comparison:

- `internal/app/desktop.go`: B02.
- `internal/desktopbridge`, `internal/protocol`, and launch wiring: no additional confirmed finding. Framing bounds, shared allowlists, identity checks, token rereads, redirect refusal and allowed response headers were checked.
- Hypothetical recoverable writers and a parent abandoning stdout were excluded after checking the actual Rust reader and process pipe lifecycle.

## Verification

| Check | Result |
| --- | --- |
| Full Node suite: `node --test --test-reporter=dot 'tests/*.test.mjs'` | Passed; includes the previous audit regressions. |
| Rust: `cargo fmt --check`, `cargo test --locked` | Passed on Windows; 24 unit tests and one dependency regression. |
| Rust: `cargo clippy --locked --all-targets -- -D warnings` | Passed. |
| Windows Go: `go test ./...`, `go vet ./...` | Passed. |
| WSL: `prepare-wsl-tests.ps1`, `run-linux-tests.sh dist/wsl2/tests` | All 11 packages passed, including real aria2 integration. |
| WSL: `smoke-linux.sh dist/wsl2/truedown-core` | SQLite, tasks, single-instance behavior, engine cleanup and dashboard exit passed. |
| `auxiliary-ui-browser.mjs` | Literal HTML labels, retained drafts/proxy state, actual startup feedback and module concurrency passed in real Chromium under production CSP. |
| Settings browser acceptance | Native/HTTP layouts at 1040/820/390 widths, light/dark, wheel/keyboard, drafts and save feedback passed. |
| Workspace, file-group and task-form browser acceptance | Desktop/mobile, 100%/200% scale, focus-preserving polling, conflicts, drafts and native-form submission passed. |
| `npm run ui:check`, `npm run icons:check` | Passed; generated UI and icon resources match their sources. |
| Python history migration / release validation tests | 13 / 27 passed using the bundled Python runtime. |
| Extension build and changelog selection | Passed. |
| `npm run build -- --debug --no-bundle` | Built current Windows `TrueDown.exe` with matching core/CLI sidecars and frontend resources. |
| Windows WebView2 hidden acceptance | All four windows, permissions, cache, auth, drafts, task refresh, scale/theme/fallbacks, core recovery, external exit and orphan cleanup passed; every window remained hidden. |
| Built-core private-pipe smoke | Attachment preserved the independent service; private auth, owned-core EOF exit and attach-only recovery passed. |
| Built-core task-settings smoke | Live speed changes, paused connections, private details, group filtering and restart persistence passed. |
| `git diff --check` and starting-snapshot comparison | Passed; unrelated prior source changes preserved. |

The new browser regression is available through `npm run test:auxiliary` in
`truedown/desktop` and runs in the existing Linux browser CI step.

Native macOS execution and physical two-monitor dragging were not available on
this host. macOS parser and bounded-process behavior were tested on Windows;
these checks do not establish platform-native behavior. This round did not rerun
Linux Tauri GUI acceptance. WSL results above cover the Go core. Hidden Windows
geometry and native paint checks are not visual-composition verification.
