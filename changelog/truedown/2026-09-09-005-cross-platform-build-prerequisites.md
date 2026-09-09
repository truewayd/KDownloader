# TrueDown - Cross-platform build prerequisites

- Build each Unix package on its matching native runner: Ubuntu 24.04 x64/ARM64
  and macOS 15 Intel/ARM64. Keep the build script's host-architecture guard.
- Install pinned Node and Rust, locked desktop npm dependencies and Linux native
  libraries before building. Native packages are built once in the four-target
  matrix; repository jobs retain extension/shared UI, Go integration/vet and
  build-safety tests. Packaged core, frontend and CLI startup are checked, with
  Linux GUI startup inside Xvfb and macOS bundle signature verification.
- Treat wholly empty optional certificate/password and Apple-ID credential
  groups as absent before invoking Tauri, avoiding attempts to import an empty
  certificate or notarize with empty credentials. Preserve configured values
  and the existing ad-hoc signing default.
- Resolve test fixture roots through OS temporary-directory aliases while
  retaining rejection of intentional symlinks and junctions. Product version
  remains 1.6.3; no application behavior or permissions change.

## Verification

- Actionlint validates the cross-platform workflow. Contract regressions cover
  all four runner mappings, dependency setup before compilation and package checks.
- Temporary-directory alias and empty signing-environment regressions reproduced
  the original failures before the fixes and pass afterward.
- Unix build guards check target dispatch, reject mismatched hosts and preserve
  configured signing inputs using compiler stubs; these do not sign a real app.
- Full Node suite (317 tests), Python migration suite (13 tests), shared UI
  consistency, extension build/changelog selection and Go tests/vet pass.
- WSL Go integration tests and native Linux core smoke pass, including single
  instance handling, dashboard exit and engine cleanup.
- New remote jobs and native macOS builds require CI; no macOS host is available
  locally. The new workflow has not yet been run on GitHub.
