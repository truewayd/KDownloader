# Prevent repeated application update downloads

- Preserve the automatic update check interval across core restarts, including failed checks and interrupted downloads.
- Turn off automatic application updates after native rollback, with an error explaining manual retry. Keep the state readable by previous builds.
- Preserve immediate manual retry and explicit re-enabling of automatic updates.
- Exit cleanly when update handoff interrupts the shell's initial core identity check, instead of panicking during setup.
- Carry owned core identity in the ordered private startup handshake, avoiding an API request that can race update shutdown.
- Extend existing updater coverage for durable retry control, automatic rollback, and outgoing shell exit during Windows handoff.

## Verification

- Go updater and application tests.
- Release workflow checks and Windows native update acceptance in CI.
