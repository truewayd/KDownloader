# Prevent repeated application update downloads

- Preserve the automatic update check interval across core restarts, including failed checks and interrupted downloads.
- Turn off automatic application updates after native rollback, with an error explaining manual retry. Keep the state readable by previous builds.
- Preserve immediate manual retry and explicit re-enabling of automatic updates.
- Extend existing updater coverage for durable retry control, automatic rollback, and outgoing shell exit during Windows handoff.
