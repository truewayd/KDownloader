# TrueDown: preserve login startup during native upgrade

- Migrate an existing Windows background command only when its executable and
  profile exactly match the native package replacing it in place.
- Keep the registry value name and Windows disabled state; do not create duplicate
  startup entries or change registrations for another program location/profile.
- Accept the legacy background argument during handoff so a registration write
  failure does not break the next login.

## Verification

- Rust tests cover quoted Windows paths, recognized upgrades and rejection of
  different executables, profiles and extra arguments in an isolated registry key.
- Clippy passes with warnings denied; no actual login/startup entry was enabled.
