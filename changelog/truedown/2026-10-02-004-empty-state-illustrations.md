# TrueDown empty-state illustrations

## Changes

- Add two Imagegen illustrations with transparent backgrounds, muted teal accents and neutral surfaces for an empty download library and search/status filters without results.
- Center empty states within the task viewport, separate artwork from readable copy, and scale artwork down for narrow or short windows. Decorative images have no accessible name, drag behavior or animation and are hidden in forced-colors mode.
- Include PNG assets in native frontend staging and keep the generation prompts in `truedown/docs/illustration-prompts.json`.

## Verification

- `npm run ui:check`: passed.
- `npm test`: 384 passed, 1 skipped.
- Python history migration tests: 13 passed.
- Native frontend preparation completed for Windows; both staged PNG hashes match the source assets.
- Browser fixture checked in light/dark themes at desktop, narrow and short window sizes; images load and empty states remain within the scroll viewport.
- Packaged native compositor behavior was not verified.
