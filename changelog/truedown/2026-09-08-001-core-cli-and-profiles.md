# TrueDown: reusable core, CLI, and shared profile preferences

- Extract the service into internal/app and add independent console core and HTTP CLI entry points. Preserve the legacy GUI/tray package.
- Add authenticated protocol and storage discovery. CLI commands cover status, add, paginated list, pause, resume, retry and graceful exit with JSON output and explicit failure codes.
- Persist task defaults in the Go profile with bounded typed validation, atomic writes and revision conflicts. Import browser defaults only into an unconfigured profile.
- Resolve new Windows profiles through LocalAppData and retain existing portable profiles. Centralize durable filenames and show the actual data directory in settings.
- Keep the standalone core outside the legacy executable updater and startup registration. Tauri packaging, process ownership, and the versioned storage-layout migration remain separate stages.

## Verification

- Go tests and go vet; Node regression suite and shared component synchronization.
- Windows legacy and core/CLI builds; local HTTP download, shared preferences, restart and graceful-exit smoke checks.
- WSL Linux tests including native aria2 recovery integration.
