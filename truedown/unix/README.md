# TrueDown on Linux and macOS

TrueDown runs as a foreground local service and keeps the existing browser
dashboard. Closing the browser does not stop downloads. Use the dashboard's
confirmed **Exit TrueDown** action or send `SIGINT`/`SIGTERM` to stop cleanly.

Each numbered TrueDown GitHub release includes these Unix packages:

- Linux: `TrueDown-build-<run>-linux-amd64.tar.gz` for x86-64 or
  `TrueDown-build-<run>-linux-arm64.tar.gz` for ARM64. Extract the archive and
  run `TrueDown` inside its package directory.
- macOS: `TrueDown-build-<run>-macos-amd64.zip` for Intel or
  `TrueDown-build-<run>-macos-arm64.zip` for Apple Silicon. Extract the ZIP
  to obtain `TrueDown.app`. These bundles are unsigned and not notarized.

Unix packages are updated manually by downloading a newer release. The
`truedown-update-<run>.json` asset is used only by the Windows self-updater.

Install aria2 1.37 or newer before starting TrueDown:

- Ubuntu/Debian: `sudo apt install aria2`
- macOS with Homebrew: `brew install aria2`

TrueDown searches its package, the system `PATH`, and the standard Homebrew
locations. `TRUEDOWN_ARIA2_PATH` may name another regular executable.

Default data locations are:

- Linux: `$XDG_DATA_HOME/truedown` or `~/.local/share/truedown`
- macOS: `~/Library/Application Support/TrueDown`

`TRUEDOWN_DATA_DIR` overrides the data location. Linux packages include a
`truedown.desktop` template for installations that place `TrueDown` on `PATH`.
The macOS application is currently an agent-style browser-dashboard app; a
native menu-bar controller and signed/notarized release remain separate release
engineering work.

On Windows, a repeatable WSL2 validation run is:

```powershell
pwsh -NoProfile -File tools/prepare-wsl-tests.ps1
wsl -d Ubuntu -- bash tools/run-linux-tests.sh dist/wsl2/tests
wsl -d Ubuntu -- bash tools/smoke-linux.sh dist/wsl2/TrueDown
```
