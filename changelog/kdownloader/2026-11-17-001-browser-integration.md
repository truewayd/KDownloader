# Optional browser download menus

- Add opt-in right-click actions for links, media and selected URL text, inspired by ABDM Browser Integration's current configuration behavior.
- Send bounded batches through the configured ABDM / TrueDown endpoint with explicit automatic start and optional API Key authentication.
- Preserve MEGA fragments, reject embedded credentials and unsupported schemes, omit page cookies and keep acceptance separate from download completion.
- Reconcile menus after configuration changes, backend disable, restore defaults and browser restart. Gopeed does not expose these ABDM-only menus.
- Bump KDownloader to 3.5.0 for the new browser context-menu permission and feature.

## Verification

- Node regressions cover URL validation, fragment preservation, batch bounds, configuration changes and authenticated handoff.
- Extension build and shared UI mirror checks pass.
