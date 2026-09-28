# Shared tooltip positioning

- Add an optional native-titlebar safe inset to the canonical tooltip runtime
  used by TrueDown. Extension pages keep their existing tooltip placement when
  no inset is configured.

## Verification

- Shared component mirror check, repository JavaScript tests, history migration
  tests and clean extension packaging.
- TrueDown tooltip acceptance covers keyboard access, themes, viewport edges
  and native-caption safe positioning at 100-200 percent display scale.
