# Windows tray lifecycle and application logs

- TrueDown now runs as a Windows tray application without opening a command
  prompt. The tray can reopen the dashboard, open downloads or the application
  log, and shut the service down gracefully.
- Launching TrueDown again reuses the instance for the same data directory and
  opens its dashboard instead of starting a second aria2 manager.
- Application events now persist in a bounded rotating `truedown.log`. The
  settings dashboard can securely read and copy the latest 256 KiB, while
  managed aria2 processes remain hidden and keep their existing diagnostics.
- Release builds verify that `TrueDown.exe` uses the Windows GUI subsystem as
  well as the embedded multi-size product icon.

## Verification

```text
cd truedown
go test ./...
go vet ./...
pwsh -NoProfile -ExecutionPolicy Bypass -File build.ps1
```
