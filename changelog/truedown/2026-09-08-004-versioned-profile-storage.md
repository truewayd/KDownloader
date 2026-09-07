# TrueDown: versioned profile storage

- Separate configuration, durable data, restart state, logs and cache through one
  typed profile owner, using Windows Known Folders, Linux XDG and macOS directories.
- Keep explicit and portable profiles grouped under their selected root; expose
  actual paths through CLI and settings without adding scattered path controls.
- Migrate existing profiles under the process lock with SQLite WAL checkpointing,
  verified copies, an atomic layout commit and resumable archival of original files.
- Preserve task identities, partial downloads and download destinations; retain
  the original profile snapshot in `profile-backup-v0`.
- Create all native WebViews after migration and share their profile cache.

## Verification

- Go tests and vet, real SQLite migration tests, Linux/WSL tests and service smoke.
- Node regressions and shared component checks; private-pipe ownership/auth smoke.
- Windows hidden native acceptance: shared cache, settings, drafts, authentication,
  role restrictions, scaled layouts and graceful exit.
