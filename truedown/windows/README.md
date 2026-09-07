# TrueDown for Windows

Extract the complete package to a writable application directory and open
`TrueDown.exe`. Keep `truedown-core.exe`, `truedown-cli.exe`, `aria2c.exe` and the
license files beside it. Windows 10/11 and the Microsoft Edge WebView2 Evergreen
Runtime are required. Closing the main window keeps downloads in the tray;
use **Exit TrueDown** to stop them. Settings, logs and about use separate windows.

Settings → Startup enables or disables launch at sign-in. Windows controls
transparency and high contrast; TrueDown follows those preferences and uses an
opaque fallback where Mica is unavailable. Tray artwork is selected at the
taskbar monitor's DPI, including fractional scaling.

The default profile is `%LOCALAPPDATA%\TrueDown`, with grouped `config`, `data`,
`state`, `logs` and `cache` directories. Downloads stay in the selected download
directory. `truedown-cli.exe --json paths` reports the actual locations.
`--data-dir <absolute directory>` or `TRUEDOWN_DATA_DIR` selects an explicit
profile; known old profiles are migrated while preserving task and download data.

For terminal use, run `truedown-core.exe serve` and use `truedown-cli.exe --help`.
The native interface can attach to an already running core for the same profile.
Core and CLI do not require WebView2. The browser dashboard remains available
at the configured loopback address, normally `http://127.0.0.1:15151`.

Numbered native builds update the complete interface/core/CLI set and its
notices together, with rollback when the new interface cannot start. The aria2
engine and profile are preserved. To migrate from the old browser-only Windows
package, exit that version and extract a complete native package; its old
single-executable updater cannot install this package format.

Source, runtime prerequisites and build instructions are in the repository:
https://github.com/truewayd/KDownloader/tree/main/truedown
