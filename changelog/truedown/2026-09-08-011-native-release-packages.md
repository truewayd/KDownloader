# Native release packages

The release pipeline now packages the Tauri interface, Go core and CLI together
on Windows, Linux and macOS. Windows verifies the native icon, GUI subsystem and
Per-Monitor V2 manifest. macOS uses a standard signed application bundle; without
Developer ID credentials its signature is ad-hoc and does not imply notarization.

The download workspace keeps application logs directly accessible and separates
settings, logs and about into reusable native windows. Categorized settings retain
drafts and expose launch-at-sign-in. Windows follows system transparency/contrast
preferences and selects exact tray rasters for the taskbar monitor's DPI; macOS
uses native controls and vibrancy. Profiles group configuration, task data, state,
logs and caches according to each OS while preserving existing downloads.

Windows updates use schema 2 with hashes for the complete application file set.
The first migration from the browser-only package requires extracting the new
complete package. Engine binaries, profiles and downloaded files remain outside
the application update transaction.

Publication requires all platform packages and native UI/recovery tests. Each
packaged frontend must acknowledge successful startup with matching core
and CLI metadata. Archive validation checks every component's architecture, Unix
executable modes, notices, exact file sets and Windows manifest hashes.

## Verification

Windows release build, embedded icon/DPI checks, archived package validation,
hidden packaged frontend startup and graceful CLI exit passed. All 279 Node
regressions, component synchronization, Go tests/vet and 12 release-validator
tests passed. Linux release startup also passed with its view mapped inside
Xvfb; WebKitGTK can defer loading unmapped views. macOS runtime
and signature verification run on macOS CI and cannot be claimed as locally tested.
