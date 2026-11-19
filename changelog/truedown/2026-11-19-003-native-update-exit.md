# Wait for TrueDown to exit before applying an update

- Wait for the old Windows desktop and its owned core to exit before replacing files or launching a new copy.
- Hide the tray icon during normal shutdown and bound Windows desktop teardown after core cleanup.
- Identify the update phase that failed when reporting a rollback.

## Verification

- Windows process tests exercise the exit deadline and PID reuse. Native update acceptance checks that the outgoing application exits before its replacement starts.
