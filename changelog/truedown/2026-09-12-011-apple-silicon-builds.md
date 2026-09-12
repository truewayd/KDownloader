# TrueDown macOS builds for Apple Silicon

- Build and publish macOS packages only for Apple Silicon (arm64); remove the Intel runner and archive from both CI matrices and the release asset list.
- Require exactly four platform packages: Windows AMD64, Linux AMD64, Linux ARM64 and macOS ARM64, plus the Windows update manifest.
- Reject Intel macOS targets before starting a local package build, while retaining native startup, recovery and archive-integrity checks for the supported platforms.
- Include the CI fixes for Windows relative-path tests, aria2 integration-test discovery and Rust Clippy from the preceding build.

## Verification

- Release workflow contracts, Unix build-safety tests and release archive validation tests.
- Full repository tests and the supported native build and acceptance matrices.
