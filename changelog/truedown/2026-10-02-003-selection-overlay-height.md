# TrueDown selection overlay height

## Fixes

- Keep the task list's scroll height unchanged when selecting or clearing tasks by removing the selection-only bottom padding. The action panel remains an overlay, with scroll padding retained for keyboard focus clearance.

## Verification

- Browser fixture with 2,400 tasks: selection and clearing preserve list geometry at 1,200px, 960px and 390px widths.
- `node --test tests/dashboardUi.test.mjs`: 16 passed.
- `npm test`: 384 passed, 1 skipped.
- `npm run ui:check`: passed.
- `python -m unittest tests/migrate_history_json_test.py`: 13 passed.
- Browser layout verified; packaged native desktop not rebuilt or verified.
