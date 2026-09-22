# TrueDown update download cleanup

- Remove verified update downloads and their completed tasks after successful installation, preserving rollback files, failed downloads and ordinary user files.
- Persist cleanup receipts separately from updater settings so old binaries can still read their settings during rollback; retry interrupted cleanup on startup and periodically.
- Document platform update locations and the remaining work for an optional Windows NSIS installer.

## Verification

- Go cleanup tests cover startup health gating, durable retries, installed engines, changed checksums, active tasks, output conflicts and directory links.
- Windows hidden update acceptance verifies successful package cleanup and retention after rollback.
