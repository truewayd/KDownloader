# NEXT 3.0.8 compatibility and browser integration review

- Recommend the reviewed NEXT 3.0.8 release with official Windows x64/ARM64
  SHA-256 pins. Retain 3.0.2, 3.0.0 and 2.8.3 regression engine selections.
- Reject `incomplete-suffix` in task options and saved defaults on every engine,
  preventing a later engine switch from changing managed output paths. Strip
  the option at RPC serialization as defense in depth for old requests.
- Keep filename method discovery authoritative while accepting 3.0.8's restored
  capability flags when discovery is unavailable.
- Fix MEGA archive recovery with sparse/preallocated members. Commit a private
  member-completion receipt before retiring native results; never skip an
  unfinished member just because its file already has the final length. Keep
  native checkpoint resume, legacy receipt migration and full MAC verification.
- Add real-engine checks for empty ranged files, noncompliant 206 responses,
  transient 429/503 responses and restored filename capability flags. Verify
  downloaded bytes through TrueDown's normal manager lifecycle.
- Refresh the ABDM 1.11.1 / browser integration 1.5.0 source review. The pending
  REST documentation PR does not change the protocol; existing typed start,
  unsupported queue/category and durable browser-import behavior is retained.
- Document the separate Rayburst Connect REST contract and optional NEXT RPCs;
  do not add new browser/native routes or broaden accepted URL protocols.

## Verification

- Unit/API checks for rejected suffix options, saved defaults, serialization,
  old-request replay preserving existing files, filename capability
  discovery/fallback and unchanged ABDM request behavior.
- Member-receipt persistence/failure/identity checks and real archive restart
  with current or missing legacy receipts, verified ZIP contents and cleanup.
- Windows x64 NEXT acceptance through `tools/test-next-engine.ps1`, including
  downloader, updater, media and API suites with the reviewed real binary.
- ARM64 release metadata/checksum validation; no ARM64 execution is claimed.
