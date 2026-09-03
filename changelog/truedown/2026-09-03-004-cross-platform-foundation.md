# Cross-platform runtime foundation

- Linux and macOS now use a CGo-free SQLite implementation instead of the
  previous unsupported placeholder, while Windows retains its reviewed system
  SQLite binding.
- TrueDown now resolves aria2 from a packaged Unix binary, the system `PATH`,
  or an explicit `TRUEDOWN_ARIA2_PATH`, and stores data in the native per-user
  application-data directory by default.
- Linux and macOS now enforce one TrueDown process per data directory with a
  non-following file lock.
- The dashboard now provides a confirmed, authenticated exit action so Unix
  builds retain the browser UI without requiring users to hunt for a process.
- Added Linux desktop and macOS application-bundle packaging, a multi-resolution
  macOS icon, and Ubuntu/macOS continuous integration. macOS packages build for
  both Intel and Apple Silicon.
- Fixed a Windows tray regression introduced when the DPI manifest moved the
  linked icon group from resource 1 to resource 2. Release builds now verify
  the exact resource used by the tray, not only the Explorer-associated icon.
- Added a WSL2 smoke suite covering the real aria2 process, SQLite persistence,
  single-instance locking, dashboard exit, and clean child-process reaping.

## Verification

```text
cd truedown
go test ./...
go vet ./...
pwsh -NoProfile -ExecutionPolicy Bypass -File build.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File tools/prepare-wsl-tests.ps1
wsl -d Ubuntu -- bash tools/run-linux-tests.sh dist/wsl2/tests
wsl -d Ubuntu -- bash tools/smoke-linux.sh dist/wsl2/TrueDown
```
