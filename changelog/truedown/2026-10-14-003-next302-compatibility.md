# Reviewed NEXT, update retries and MEGA icon

- Review the official 3.0.1/3.0.2 changes and pin Windows real-engine acceptance
  to NEXT 3.0.2 with its published SHA-256. Keep 3.0.0 and 2.8.3 regression lanes.
- Disable ambient aria2 configuration and daemon startup for managed engines,
  preserving TrueDown's child-process ownership and recovery behavior after
  NEXT adds Windows daemon support.
- Run browser-media and probe API acceptance with the actual selected NEXT
  version, including later patch releases instead of only exact 3.0.0 matches.
- Retain native gzip handling and live global-option propagation. Add real
  HTTP checks for negotiated/unsolicited gzip and unchanged gzip archives.
- Keep the existing authenticated loopback JSON-RPC integration, native HTTP
  checkpoints, media execution and update verification contracts.
- Bind NEXT discovery to the release reviewed with each TrueDown build, using
  one embedded version/checksum policy shared with release acceptance. Do not
  automatically adopt a newer upstream release before TrueDown validates it.
- Offer a verified previous-NEXT rollback in settings. Persist the selection
  and hold automatic reinstallation of the rejected version across restarts;
  explicit recommended-version installation can clear the hold.
- Replace MEGA's generic cloud icon with a recognizable circular M provider
  mark in the canonical generated sprite, matching the shared monochrome strokes.
- Track TrueDown, NEXT and MEGA update failures independently. Add a same-row
  action to the compact information area for retries, verified application
  restart and ready-engine application, including collapsed navigation.
- Share the full update operation between settings and information-area actions.
  Retry download, validation, installation and activation rather than only an
  old package transfer; coalesce duplicate requests for the same update.
- Report MEGA module checking, download progress and installation separately,
  and retain module feedback in its settings entry.
- Refresh global restart impact before showing a confirmation. Idle queues
  restart directly; unfinished work and caller-owned settings drafts remain
  protected. Keep the final core task/module gate independent of UI reads.

## Verification

- Real NEXT 3.0.2 downloader, media, probe, API and binary identity acceptance.
- Reviewed-release checksum binding, durable rollback, rejected binary and
  persistence-failure checks, plus native startup configuration isolation.
- Settings rollback confirmation and MEGA layout in light/dark desktop and
  narrow browser fixtures; Go/Node regression suites and generated asset checks.
- Information-area retries for all three update kinds, duplicate-click handling,
  MEGA install/progress states and closed native window-role permissions.
- Idle direct restart, fresh busy/cached idle and fresh idle/cached busy states,
  draft cancellation, duplicate clicks, failed reads and stale update readiness.
