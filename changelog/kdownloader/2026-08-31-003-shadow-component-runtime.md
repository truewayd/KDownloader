# Shared Shadow component runtime

- Added one canonical component runtime for busy states, notifications,
  progress, segmented controls, accessible icons, injected actions, and the
  external-links dialog.
- Migrated every Kemono, Coomer, Pawchive, CoomerFans, and Favorites injected
  control to Shadow DOM while retaining native buttons, the existing muted
  teal style, keyboard behavior, light/dark themes, and reduced motion.
- Reduced the host-injected stylesheet to layout rules so third-party page CSS
  cannot restyle component internals, and removed all legacy injected button
  and modal implementations.
- Kept popup and settings form controls in semantic Light DOM and routed their
  shared behavior through the same runtime.
- Made settings panels and segmented controls shrink and wrap safely at narrow
  viewport widths without changing the desktop layout.
- Made source-contract tests normalize CRLF and LF consistently so Windows CI
  no longer reports false function-boundary failures.

## Verification

```text
npm run ui:check
npm test
python -m unittest tests/migrate_history_json_test.py
pwsh -NoProfile -ExecutionPolicy Bypass -File tools/build-extension.ps1
```
