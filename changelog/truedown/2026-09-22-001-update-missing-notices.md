# TrueDown updates with missing installed license notices

- Fix native updates failing with `inspect installed NATIVE_LICENSES.txt` when an older installation lacks its license inventory. Missing installed notice files are supplied by the fully verified new package; missing executables still block the update.
- Record missing notices explicitly in the update transaction. Interrupted updates and failed startup health checks restore their original absence, without using stale backups or deleting unrelated files.
- Keep complete release file, size, SHA-256 and executable identity verification mandatory.

## Verification

- Regression tests cover missing notices, each partial activation and repeatable rollback, stale backups, changed targets, corrupt or missing staged notices, and invalid transaction metadata.
