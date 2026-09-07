# TrueDown: native core supervision

- Recover a disconnected native core up to three times per incident, retaining
  durable settings/tasks and existing window drafts without replaying requests.
- Treat authenticated CLI/browser exit as intentional and close the desktop.
- Keep reconnecting independent services in attachment-only mode.
- Place Windows console cores and their engines in a process-lifetime job before
  spawning downloads; keep user-opened Explorer windows outside that job.
- Give aria2 the owner's PID for its cross-platform parent-death shutdown watch.
- Bound stalled private-pipe writes and retain a graceful shutdown interval.

## Verification

- Go regressions and private-pipe owned/attached/authentication smoke.
- Rust recovery-budget tests and Clippy with warnings denied.
- Hidden Windows native acceptance: forced core death, old engine removal,
  one recovered core, preserved settings/drafts and intentional external exit.
