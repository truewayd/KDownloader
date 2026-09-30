# TrueDown interaction feedback

- Align the sticky add-group action with the top of the settings scrollport.
- Animate the sidebar selection indicator with a cubic-bezier curve, preserve native material through hover/selection, and unify search geometry and clear controls.
- Move multi-selection actions into a bottom floating bar with selection highlighting and clear-selection focus restoration.
- Persist updater-owned task identity, distinguish update transfers visually, and explain pause/removal/retry consequences in native confirmations, including selected tasks and global pause.
- Add toast entrance/exit transitions and respect reduced motion.
- Keep ordinary borders thin and low contrast; use a borderless floating selection surface outside forced-color mode.
- Checkbox controls use one 1 px outline and a 1.5 px check, including indeterminate state, with native forced-color rendering.

## Verification

- Browser fixtures cover light/dark, narrow/desktop, sticky geometry, unchanged virtual viewport, cancellation without mutations, search clearing, selection movement and toast dismissal.
- Go regression covers update identity persistence and ordinary package isolation.
- Node suite: 379 passed, one skipped; Go tests/vet and WSL Linux integration/smoke passed. Shared UI mirror, 13 Python tests and extension build passed.
- Browser screenshots do not establish native DWM/Mica composition or real update installation acceptance.
