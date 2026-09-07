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
- Settings, application logs and about each reuse one separate native window.
  Settings drafts and category selection remain intact when hidden and reopened.
- Ctrl/Cmd+, opens settings, Ctrl/Cmd+S saves its current category, and Escape or
  Ctrl/Cmd+W hides auxiliary windows when no confirmation dialog is active.
- The Go resolver determines the profile; its identity scopes the desktop instance
  and login entry. Existing entries owned by another executable are not overwritten.
- Windows uses Mica when supported and allowed by system transparency/contrast
  preferences. macOS uses native vibrancy and system controls. Working surfaces
  stay opaque, and unsupported effects fall back to normal backgrounds.
- Windows chooses a 16/20/24/32/40/48/64-pixel tray raster using the taskbar monitor
  DPI and refreshes after taskbar movement. macOS treats the icon as a template.

## Release integration still in progress

This directory is the native migration implementation, not a replacement for the
existing release pipeline yet. The legacy single-executable updater is disabled
for sidecars. Full-bundle update/rollback, native
Unix acceptance and signing/notarization must be completed before switching the
published product. Keep the legacy and native update mechanisms separate until
that release transition is tested.
