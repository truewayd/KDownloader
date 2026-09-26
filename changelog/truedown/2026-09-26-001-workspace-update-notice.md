# TrueDown workspace update notice

- Replace the main sidebar Exit button with a compact status notice. Exit remains
  available in the native tray.
- Show updater-owned download progress and speed, pause/queue/verification states,
  pending restart, update errors and engine recovery independently of task filters.
- Reuse the native restart confirmation and queue safety checks. Keep existing
  Windows automatic checks, verified downloads and idle application behavior.
- Add the settings search icon and keep both search icons above input surfaces.
- Suspend status reads when hidden, recover with bounded backoff, and retain an
  accessible icon action in the collapsed sidebar.
- Cover updater progress, native role authorization, filtered-list progress,
  restart cancellation, failure recovery and light/dark responsive layout.

## Verification

- Shared UI mirror and repository Node tests.
- Go updater/downloader progress tests, full Go tests and vet.
- Native Rust tests and formatting checks.
- Workspace, settings and update-notice browser acceptance with light/dark,
  compact sidebar, filtered task lists, cancellation and recovery screenshots.
