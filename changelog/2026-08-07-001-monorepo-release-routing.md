# Monorepo release routing

KDownloader and TrueDown now live in one repository and publish independently.

## Changes

- Added TrueDown under `truedown/` with its Go sources, embedded web UI, tests,
  bundled aria2 executable, and repeatable Windows build script.
- Scoped the existing KDownloader release workflow to KDownloader paths.
- Added a TrueDown workflow that tests, builds, archives, and publishes only
  when TrueDown paths change.
- Assigned TrueDown its own release tag prefix so both products can be released
  from the same commit without tag collisions.

## Verification

- Run the KDownloader Node and Python test suites.
- Build the unpacked KDownloader extension and select the latest changelog.
- Run `go test ./...` and `build.ps1` from `truedown/`.
