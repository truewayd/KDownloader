# TrueDown: private desktop transport

- Add a bounded inherited stdio bridge that reuses the Go application's existing API handlers and download manager.
- Attach to an existing service only after protocol, product and profile validation. Preserve independent services when the desktop connection closes; shut down desktop-owned cores on EOF.
- Keep the HTTP listener's authentication and browser-integration boundary intact. Share an explicit method/path manifest between clients.

## Verification

- Go profile, application and desktop-bridge tests.
- Real core smoke: owned startup, existing-service attachment, authentication enabled, EOF cleanup and independent-service preservation.
