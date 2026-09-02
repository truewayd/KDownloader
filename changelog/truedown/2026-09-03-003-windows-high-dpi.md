# Windows high-DPI tray scaling

- TrueDown now declares Per-Monitor V2 DPI awareness with a compatible legacy
  per-monitor fallback, preventing Windows from bitmap-scaling its tray menu.
- The tray message thread keeps the Per-Monitor V2 context so native menu
  metrics and cursor coordinates follow the monitor that owns the taskbar.
- Windows builds now reject an executable whose embedded DPI manifest differs
  from the reviewed source manifest.

## Verification

```text
cd truedown
go test ./...
go vet ./...
pwsh -NoProfile -ExecutionPolicy Bypass -File build.ps1
```
