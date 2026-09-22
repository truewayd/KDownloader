# TrueDown build dependency update

- Upgrade actions/setup-node from 4.4.0 to 7.0.0 across release, cross-platform and native validation workflows, pinned to the reviewed upstream commit.
- Keep the build runtime on Node.js 22 and explicitly disable automatic package-manager caching to preserve existing build behavior.

## Verification

- Run release workflow safety tests and the complete repository test suite.
- Validate native builds and packaged startup on Windows AMD64, Linux AMD64/ARM64 and macOS ARM64 through GitHub Actions.
