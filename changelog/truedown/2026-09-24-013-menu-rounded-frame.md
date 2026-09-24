# TrueDown: restore rounded native menu framing

- Retain the user-reviewed opaque-menu baseline in commit 643bb65. Its local
  frame5 diagnostics show that the return hook never observed a menu window;
  the intended custom rounded frame was therefore not being applied.
- Observe native popup creation/initial positioning with a scoped call hook and
  install a subclass. Suppress the legacy square shadow early, but defer HMENU
  verification and DWM styling until the native position handler returns. Avoid
  querying menu geometry or changing DWM attributes during pending layout.
- Follow the supplied menu reference with a near-white surface, subdued hover,
  fine gray outline and DWM corners/shadow. Keep native measurement, hit testing,
  monitor placement and focus behavior; retain opaque rendering without Acrylic
  or glass and disable per-popup transitions. High contrast stays native.
- Label bounded local diagnostics as frame6 to identify this acceptance build.

## Verification

- Windows debug build and test-target compilation only; no interactive or
  automated test execution. User acceptance remains required for rounded
  corners, shadow, pointer alignment and dismissal.
