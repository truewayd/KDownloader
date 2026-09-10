# TrueDown on Linux and macOS

Open `TrueDown` in the extracted Linux package, or move `TrueDown.app` to
Applications on macOS and open it. Settings, logs and about use separate native
windows. Closing a window keeps downloads running; use the tray/menu bar's
**Exit TrueDown** action to stop cleanly. Settings → Startup controls launch at sign-in.

Each numbered TrueDown GitHub release includes these Unix packages:

- Linux: `TrueDown-build-<run>-linux-amd64.tar.gz` for x86-64 or
  `TrueDown-build-<run>-linux-arm64.tar.gz` for ARM64. Extract the archive and
  run `TrueDown` inside its package directory.
- macOS: `TrueDown-build-<run>-macos-amd64.zip` for Intel or
  `TrueDown-build-<run>-macos-arm64.zip` for Apple Silicon. Extract the ZIP
  to obtain `TrueDown.app`. Builds use an ad-hoc signature unless the release
  pipeline has Developer ID credentials. Ad-hoc signing does not provide Apple
  notarization; follow macOS's normal trusted-app approval flow when needed.

Unix packages are updated manually by downloading a newer release. The
`truedown-update-<run>.json` asset is used only by the Windows self-updater.

Install aria2 1.37 or newer before starting TrueDown:

- Ubuntu 24.04 or newer: `sudo apt install aria2 libwebkit2gtk-4.1-0 libayatana-appindicator3-1 libxdo3`
- macOS with Homebrew: `brew install aria2`

TrueDown searches its package, the system `PATH`, and the standard Homebrew
locations. `TRUEDOWN_ARIA2_PATH` may name another regular executable.

The Linux archive requires GTK3 and WebKitGTK 4.1, provided by the packages above,
and is built on Ubuntu 24.04. Keep both sidecars beside the native executable.

Default profile locations are:

- Linux: configuration under `$XDG_CONFIG_HOME/truedown`, task data under
  `$XDG_DATA_HOME/truedown/data`, state/logs under `$XDG_STATE_HOME/truedown`,
  and cache under `$XDG_CACHE_HOME/truedown`, with standard XDG fallbacks.
- macOS: configuration, task data and state under
  `~/Library/Application Support/TrueDown`; logs under `~/Library/Logs/TrueDown`
  and cache under `~/Library/Caches/TrueDown`.

Downloads remain in the selected download directory. `--data-dir <absolute
directory>` or `TRUEDOWN_DATA_DIR` selects a grouped explicit profile. Existing
profiles migrate automatically while preserving tasks and downloaded files.
`truedown-cli --json paths` reports actual paths without starting the application.
On macOS the CLI and core are in `TrueDown.app/Contents/MacOS`.

HTTP retries keep the task's existing output name. Valid `.aria2` resume files
preserve progress; missing or confirmed damaged resume data restarts only that
task's file from zero. New tasks may receive a numbered filename on collision.
Old numbered siblings are never deleted automatically. Full rules are in
`truedown/docs/download-retry-rules.md` in the source repository.

Linux packages include a
`truedown.desktop` template for installations that place `TrueDown` on `PATH`.
For terminal use, run `truedown-core serve`, then `truedown-cli --help` for commands.
The native interface attaches to a running core for the same profile. Terminal
components do not require a graphical session. The browser dashboard remains
available at the configured loopback address, normally `http://127.0.0.1:15151`.
