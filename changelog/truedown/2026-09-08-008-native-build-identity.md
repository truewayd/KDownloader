# Bind native components to one release

- Generate one validated build identity for the native shell and both Go
  sidecars; numbered builds include the release tag, build number and commit.
- Verify the local CLI before resolving a profile and verify every owned core
  connection before serving native requests. Reject mixed release components.
- Keep protocol-compatible attachment to an independently running service.

## Verification

Go CLI/application tests, Rust clippy, and hidden Windows native
window/settings/core-recovery/shell-crash acceptance pass.
