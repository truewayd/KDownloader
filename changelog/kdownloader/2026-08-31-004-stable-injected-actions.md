# Stable injected action placement

- Protected creator and Favorites action host geometry from third-party page
  CSS so circular controls retain their intended size and remain inside their
  cards.
- Restored a reliable pointer cursor and pointer hit area on enabled injected
  actions while preserving the disabled cursor state.
- Restored the migration-era bottom-right geometry and circular background
  exactly, including a solid-color compatibility fallback when `color-mix`
  is unavailable.
- Added an explicit action factory that verifies the internal native button,
  catches constructed-stylesheet adoption failures, imperatively hydrates the
  same Shadow DOM when Chrome's isolated world leaves the host unupgraded, and
  repairs missing Shadow styles after connection instead of leaving a plain
  custom element or aborting the complete route render.
- Added the same verified factory boundary to the external-link dialog and
  restored pointer state on both the action host and its native Shadow button.
  The dialog's upgraded and isolated-world fallback paths share one controller
  for focus trapping, cleanup, and close behavior.
- Preserved filtered external links from incomplete Pawchive posts while still
  rejecting their media fields, and kept link-only/empty actions manually
  retryable so their modal can be reopened without clearing history.
- Preserved pre-positioned host containers, established relative positioning
  only when required, and removed extension-owned positioning markers during
  stale-item and route cleanup.
- Added regression coverage for hostile host selectors, active-action
  reinjection, verified Shadow initialization, dialog creation, incomplete
  link extraction, pointer fallback, and positioning-context cleanup.

## Verification

```text
npm run ui:check
npm test
python -m unittest tests/migrate_history_json_test.py
pwsh -NoProfile -ExecutionPolicy Bypass -File tools/build-extension.ps1
```
