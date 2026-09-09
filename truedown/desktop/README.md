# TrueDown desktop

The Tauri shell bundles the existing frontend and two Go sidecars. The core owns
all download, resolver, authentication and durable configuration behavior. Rust
owns windows, tray, login startup and native clipboard access. The browser uses
the existing authenticated HTTP API; bundled windows use a private inherited pipe.

## Development

Install Node.js, Go, Rust and the platform's
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), then run:

```text
npm ci
npm run build -- --debug --no-bundle
npm run check
cargo clippy --locked --all-targets -- -D warnings
```

The build prepares target-suffixed sidecars and verifies the canonical shared
components before copying frontend assets. Windows includes the reviewed stable
aria2 executable. Linux and macOS require an installed aria2 or a packaged copy.

Use the Tauri build command above before native acceptance. Plain `cargo build`
emits `truedown-desktop.exe` on Windows and does not refresh a previously renamed
`TrueDown.exe`; mixing that older executable with new sidecars fails the release
identity check.

On Windows, run `npm run test:windows` after building. This uses the installed
WebView2 runtime through Playwright CDP. It copies the debug package into an
isolated temporary directory with spaces, keeps every native window hidden, and
checks settings persistence, draft retention, authentication, restricted window
commands, contrast fallback, scaled layouts and graceful exit. No separate
Chromium download or interactive confirmation is needed. Test screenshots and
profile fixtures remain in the reported temporary directory for diagnosis.

Windows and Linux windows share the resolved profile's WebView cache. The core commits storage
migration before any WebView is created; the native builder receives the absolute
cache path directly, because Tauri's JSON window configuration accepts only a
relative `dataDirectory`. Auxiliary windows do not create separate browser caches.

## Window behavior

- Main is the download workspace. Closing it hides the window while downloads run.
- New and batch downloads use separate singleton native forms with retained drafts.
  Creation and monitor fitting use the same role-specific minimum sizes.
- Settings reuses one native window, including application logs and About.
  Reopening selects Download and speed; unsaved category drafts remain intact.
  Windows/Linux retain native caption buttons and macOS retains traffic lights.
- Ctrl/Cmd+, opens settings, Ctrl/Cmd+S saves its current category, and Escape or
  Ctrl/Cmd+W hides auxiliary windows when no confirmation dialog is active.
- The Go resolver determines the profile; its identity scopes the desktop instance
  and login entry. An in-place Windows upgrade migrates its recognized Go startup
  command while preserving the OS disabled state; other executables' entries stay intact.
- Windows uses Mica when supported and allowed by system transparency/contrast
  preferences. macOS uses native vibrancy and system controls. Working surfaces
  stay opaque, and unsupported effects fall back to normal backgrounds.
- Windows chooses a 16/20/24/32/40/48/64-pixel tray raster using the taskbar monitor
  DPI and refreshes after taskbar movement. macOS treats the icon as a template.

Native IPC dispatch and credential handling live in `src/commands.rs`; explicit
window permissions and sizes live in `src/windows.rs`. Native form lifecycle is
in `../web/task-forms.js`. The [Tauri audit](../docs/tauri-audit-2026-09-08.md)
records cancellation, request-boundary and UI regressions plus dependency risks.
The [reviewed dependency patches](vendor/README.md) retain exact upstream
provenance and licenses. `node ../tools/verify-native-patches.mjs` checks every
vendored source file; native license generation runs the same check. On Linux,
also run `cargo test --locked --release --test dependencies` for the optimized
GLib FFI regression. Version-only GLib advisories must be assessed against the
patched source rather than hidden with a global ignore rule.

## Native packages

From the repository root, `truedown/build.ps1` produces the Windows package.
`bash truedown/build-unix.sh linux amd64` (or the matching host OS/architecture)
produces a Linux package or standard macOS `.app`. Install the desktop npm
dependencies first. The platform scripts use Tauri's release build and package
the matching shell, Go core, CLI and pinned dependency notices together.

Numbered Windows packages use the complete schema-2 bundle updater, with startup
health checks and rollback. Independent core services leave application updates
to their package owner. Migrating from the old browser-only Windows package
requires extracting a complete native package; its single-file updater cannot
install the new format. Linux and macOS replace the complete package manually.

Release jobs accept each packaged application's frontend startup and CLI
before archiving. All platform builds and the reusable native UI/recovery test
matrix must succeed before publication. Archive validation checks all component
architectures, executable modes, exact file sets, and every Windows update hash.
Windows uses the production background launch; Linux maps its view only inside
Xvfb because WebKitGTK can defer loading an unmapped view.

macOS packaging uses Tauri's [signing environment](https://v2.tauri.app/distribute/sign/macos/).
Without Developer ID credentials it uses an ad-hoc signature and verifies it;
this is not notarization. Configured certificate and notarization credentials
are passed only to the build step. No local macOS runtime is available for acceptance.
