# TrueDown: continuous migration to installer updates

- Keep the Windows installer as the primary download and the only update format selected by migrated clients.
- Publish a matching compatibility ZIP and schema-2 manifest in every release. Old native clients select the highest build before checking its assets; retaining only one historical bridge would strand users who skip it.
- Validate all seven assets and identical native components in both update manifests before publication. Existing size, checksum, executable identity, health and rollback checks remain mandatory.
- Include bounded task-page caching, adjacent-page prefetch and task-change notifications, with revision-aware row reuse and native read deadlines.
- This migration preserves portable profiles and does not register an installation. Pre-native single-executable clients still need a complete native installation; inline-only discovery depends on GitHub exposing inline assets.

## Verification

- Release validation requires both compatibility assets on every build and rejects incomplete or mismatched bundles.
- Node task-page tests cover bounded concurrency, stale results, core restart, conditional responses and cache limits.
- Go tests cover task change wakeup/cancellation, page versions and API validation; browser viewport checks cover scrolling and row reuse.
- Release CI verifies packaged startup across supported platforms and Windows installer staging, install, reinstall and uninstall.
