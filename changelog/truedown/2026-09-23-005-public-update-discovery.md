# Verify the complete public updater discovery path

- Verify the public stable release ID and all five uploaded files anonymously through the same asset endpoint used by build 48 and later.
- Report missing inline GitHub assets separately as an explicit compatibility warning for older clients, which need a one-time manual upgrade. Missing, mismatched or inaccessible actual assets still fail publication checks.
- Build 49 packages and native tests passed; its final legacy-only visibility check reproduced GitHub's omitted inline assets on the hosted runner as well as locally. Downloadable files remained available.

## Verification

- Tests cover complete public discovery, missing inline metadata, mismatched release IDs and incomplete fallback assets. The workflow retains anonymous requests, byte/time bounds and full uploaded-file validation.
