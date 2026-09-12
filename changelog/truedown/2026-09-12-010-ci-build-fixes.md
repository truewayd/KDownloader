# TrueDown CI build fixes

- Make the relative-output ownership regression independent of Windows checkout and temporary-directory drive letters.
- Let the queued-update integration test use aria2c from PATH when no explicit engine path is configured.
- Use Rust error propagation accepted by the native Clippy gate for opening the dropped-link task form.
- Preserve all native acceptance and package validation gates for the five release platforms.

## Verification

- Relative/absolute output ownership regression and real aria2 update progress, pause/resume, retained output and content checks.
- Rust formatting and Clippy with warnings treated as errors.
- Release workflow contracts and the full repository test suites.
