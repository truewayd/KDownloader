# TrueDown dependency security and monitoring

- Update Tauri to 2.11.6 for the channel response access-control fix
  GHSA-w28w-mhc8-qvjv, and update the desktop CLI to 2.12.0.
- Raise the Go build baseline to 1.26.8; update x/sys to v0.48.0, SQLite to
  v1.60.1 and libc to v1.77.1 with verified module checksums.

- Extend weekly Dependabot checks to desktop npm/Cargo and the core Go module;
  group compatible minor and patch updates within each ecosystem.
- Audit npm build dependencies, verify Go module checksums and run the pinned
  Go vulnerability checker in native Windows, Linux and macOS validation.
- Document the build-toolchain security boundary, full Rust lockfile review,
  advisory-index lag and the remaining GLib version-only finding.

Dependency updates still require tests, reviewed source patches and complete
native license notices before release.

## Verification

- The native workflow retains the pinned build toolchain and source-patch tests.
- The pinned Go vulnerability checker passes locally with Go 1.26.8 on Windows.
- npm audit reports zero vulnerabilities in the locked desktop dependency graph.
- All 380 Node tests complete with 379 passed, one skipped and no failures;
  Python migration tests, extension build and shared UI synchronization pass.
- The Windows desktop debug build and hidden native window acceptance pass.
- Go tests and vet pass on the exact Go 1.26.8 baseline.
- WSL Linux core tests, native aria2 integration and SQLite startup smoke pass.
- Rust formatting, Clippy with warnings denied and all 44 Windows tests pass.
- Both optimized Linux dependency regressions pass; native license generation
  covers 284 Windows and 372 Linux dependencies with verified local patches.
- Linux/macOS hosted workflow execution will be verified when commits are pushed.
