# Native desktop, shared core and profile migration

TrueDown now ships a Tauri desktop with a reusable Go core and a separate CLI.
The download workspace opens settings, application logs and about in reusable
native windows. Settings have an overview and categories, retain drafts when
reopened, and save each category independently. Task rows update by identity and
hidden task views stop polling to reduce rendering work.

Windows retains TrueDown's design with Fluent styling, Mica when allowed by
system preferences, and exact tray rasters from 100% through 400% scaling.
Window sizes account for native frames and the current monitor's work area.
macOS uses system styling, vibrancy and a Retina template status icon. Opaque
fallbacks remain available for unsupported effects and accessibility preferences.

Login startup is optional and profile-scoped on Windows, Linux and macOS. The
native shell owns all windows, tray and OS registration; the old Go desktop
launcher is removed. Start `TrueDown` for the desktop, `TrueDown --background`
for tray startup, `truedown-core serve` for an independent service, and
`truedown-cli --help` for command-line task management. Existing HTTP browser
integrations remain supported. Owned cores recover from unexpected failures;
detaching a desktop preserves an independently started service.

One versioned profile manifest groups configuration, task data, recovery state,
logs and cache using each OS's standard locations. Existing portable profiles
remain at their selected root. Migration checkpoints SQLite, verifies copies,
keeps an original-layout backup, and preserves downloaded files and output paths.
Task defaults are persisted centrally with revision checks across clients.

Native packages include the matching shell, core, CLI and pinned dependency
license notices. Numbered Windows releases update the complete application set
with per-file hashes, startup health checks, rollback and interrupted-update
recovery. The old single-executable updater is removed; first migration from a
browser-only release requires extracting a complete native package. Independent
services and Linux/macOS installations are updated through their package owner.

## Verification

All 279 Node regressions and shared-component synchronization passed. Windows
and Linux Go tests and vet passed. Hidden WebView2 acceptance covered all four
windows, shared settings/cache, drafts, authentication, DPI layouts, core recovery,
external exit and engine cleanup after shell termination. Linux WebKitGTK passed
the four-window, settings and layout checks under Xvfb. A Windows process test
verified that a replacement standalone core survives the old core's job exit.

Hidden native Windows update acceptance passed successful replacement, failed
startup health rollback and recovery after partial replacement, checking every
application hash and preserving aria2. Release-package startup is validated
with the packaged CLI and owned core. Publication requires all five platform
packages and native validation; archive checks enforce file sets, architecture,
Unix permissions, notices and Windows update hashes.

macOS compilation, packaged WKWebView startup and signature checks are configured
for macOS CI and were not run locally. Without Developer ID credentials macOS
packages use an ad-hoc signature; notarization requires configured release
credentials. Tests did not open interactive windows or change login startup on
the user's desktop.
