# TrueDown auxiliary Mica surfaces

## Changes

- Let Windows settings, new-download and task-detail content and footers expose the same Mica backdrop as their captions, retaining readable control surfaces and solid accessibility fallbacks.
- Extend the native backdrop across the client area, including standard-caption confirmations, without changing native caption controls or their WebView exclusion region.

## Verification

- `npm test`: 384 passed, 1 skipped; `npm run ui:check` and `npm run icons:check` passed.
- Native Cargo build passed; 43 unit tests and 1 dependency regression passed.
- Windows hidden acceptance passed: Mica content transparency, light/dark themes, forced colors, reduced transparency, caption geometry, scaling and auxiliary window behavior.
- Auxiliary browser checks passed, including confirmation sizing, transparent content and footer bounds.
- Visible desktop compositor appearance was not verified; no user installation was modified.
