# TrueDown for Windows

Download `TrueDown-build-N-windows-amd64-setup.exe` from the release and run it.
The installer registers TrueDown for the current user, creates shortcuts and
installs the complete application and its dependencies. Exit TrueDown before
reinstalling or uninstalling. Windows 10/11 and Microsoft Edge WebView2 Evergreen
Runtime are required; setup downloads the runtime when missing, requiring an
Internet connection. Closing the main window keeps downloads in the tray;
use **Exit TrueDown** to stop them. Logs and About are categories in the same settings window. Settings opens
Download and speed and retains unsaved edits. Window buttons are provided by Windows.

Settings → Network and retry defaults to the Windows system proxy; choose a
custom HTTP(S) address or No proxy from its dropdown. File groups support custom
suffixes and icons. Logs refresh and follow the latest entries; the core rotates
them daily or at 4 MiB, retaining at most three archives for seven days.

Settings → Startup enables or disables launch at sign-in. Windows controls
transparency and high contrast; TrueDown follows those preferences and uses an
opaque fallback where Mica is unavailable. Tray artwork is selected at the
taskbar monitor's DPI, including fractional scaling.

The default profile is `%LOCALAPPDATA%\TrueDown`, with grouped `config`, `data`,
`state`, `logs` and `cache` directories. Downloads stay in the selected download
directory. `truedown-cli.exe --json paths` reports the actual locations.
`--data-dir <absolute directory>` or `TRUEDOWN_DATA_DIR` selects an explicit
profile; known old profiles are migrated while preserving task and download data.

HTTP retries keep the task's existing output name. Valid `.aria2` resume files
preserve progress; missing or confirmed damaged resume data restarts only that
task's file from zero. New tasks may receive a numbered filename on collision.
Old numbered siblings are never deleted automatically. Full rules are in
`truedown/docs/download-retry-rules.md` in the source repository.

For terminal use, run `truedown-core.exe serve` and use `truedown-cli.exe --help`.
The native interface can attach to an already running core for the same profile.
Core and CLI do not require WebView2. The HTTP API remains available
at the configured loopback address, normally `http://127.0.0.1:15151`, for CLI
and browser-extension integrations. This address does not serve a webpage;
use the TrueDown desktop application for the graphical interface.

Numbered native builds update the complete interface/core/CLI set and its
notices together, with rollback when the new interface cannot start. The product version and release build number are displayed separately. Automatic
application waits for an idle queue and respects the saved toggle. Development
packages cannot self-update. The aria2 engine and profile are preserved.

Aria2 Next is optional and must first be installed and selected explicitly. A
separate automatic update preference checks newer stable versions, verifies their
checksum and executable version, and switches an active NEXT engine only while
idle. New profiles enable this preference; older profiles keep manual updates.
Failed switches retain the previous working engine. To migrate from the old browser-only Windows
package, exit that version and run the installer; its old single-executable
updater cannot install this package format. Existing portable users with an
explicit or portable profile should keep using that same profile when launching
the installed application. Build 94 alone includes the ZIP/schema-2 migration
assets for old clients. Later updates use the setup executable and schema-3 JSON. Older clients that miss build 94 need one manual installation.

Source, runtime prerequisites and build instructions are in the repository:
https://github.com/truewayd/KDownloader/tree/main/truedown
