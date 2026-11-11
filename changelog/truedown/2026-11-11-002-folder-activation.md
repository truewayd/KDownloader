# Restore repeated download-directory activation

- Delegate the user's path-open foreground permission from the owned native shell to its core and exact private helper before delivering the target path.
- Allow the existing Windows Shell process to activate a reused folder window. Do not grant all processes activation rights, simulate input, change system focus policy or retry arbitrary actions.
- Keep private parent/pipe validation, guarded local targets, detached helper lifetime, bounded diagnostics and timeout behavior.

## Verification

- Windows helper regression verifies delegation to the same executable's live private child before path dispatch, without opening visible windows.
- Existing opener validation, foreign-parent rejection, helper lifetime and bounded-output tests pass.
- Native build, formatting, clippy and desktop acceptance are tracked on the pushed commit.
