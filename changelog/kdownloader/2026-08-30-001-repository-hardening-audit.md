# Repository hardening and performance audit

- Hardened extension RPC authorization, accepted-request idempotency, history imports, native fallback state, Watch storage, Unicode normalization, URL parsing, same-family cookie/referrer forwarding, and external-link handling with explicit size and identity bounds.
- Replaced delimiter-concatenated history and creator-flag keys with collision-safe tuple encoding, fixed import-generation commit races, made paged exports reject mixed-revision snapshots, fixed secret migration ordering, and removed the unused creator-access sync-storage write path.
- Reduced hot-path allocations and retained objects with a single request-indexed download message dispatcher, eager queue-slot release, ordered preallocated result arrays, renderer cleanup, bounded caches, and fewer redundant scans.
- Made history migration output crash-safe and validated, and protected extension builds and release-note selection from source or output reparse-point traversal.
- Pinned release actions to reviewed immutable commits, bound releases to the tested commit, and added extension, migration, timeout, and dependency-update safeguards to CI.

## Verification

- `npm test`
- `python -m unittest tests/migrate_history_json_test.py`
- `pwsh -NoProfile -ExecutionPolicy Bypass -File tools/build-extension.ps1`
- `pwsh -NoProfile -ExecutionPolicy Bypass -File tools/read-latest-changelog.ps1 -Product KDownloader -OutputFile release-notes.md`
