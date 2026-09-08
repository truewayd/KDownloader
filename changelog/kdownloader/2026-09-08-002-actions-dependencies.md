# Build dependency updates

Upgrade the SHA-pinned checkout, upload-artifact and GitHub Release actions in
the extension release workflow. TrueDown workflows also update setup-go and
download-artifact. Artifact naming and strict release validation are preserved.

Advance the shared product version to 1.4.0 alongside TrueDown file groups and
single-task pages. Extension download behavior is unchanged.

## Verification

Repository Node tests, the shared component/icon checks, 13 Python history
migration tests and the clean extension build pass locally. Upstream release
notes confirm that the existing archived artifact upload/download flow remains
supported; download digest mismatches now fail by default.
