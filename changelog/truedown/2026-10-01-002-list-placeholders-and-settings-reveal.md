# TrueDown scrolling placeholders and settings reveal

- Request virtual task windows during continuous scrolling, coalesced per frame.
  Returning to the loaded window invalidates a pending jump so late responses
  cannot replace the visible tasks.
- Fill unloaded regions with skeleton rows measured from the real task layout,
  preserving column alignment, icon surfaces and 64px row height. A moving
  gradient sweeps through the shapes; reduced motion uses a static tile. Keep
  the 100-task DOM window and bounded reads.
- Reveal settings categories together after their initial reads and rendering
  finish, using a 180ms opacity-only fade that retains sticky geometry. Keep navigation,
  loading/retry feedback and cached drafts available. Reduced motion displays
  completed settings immediately.
- Remove the display-only ordinal column and its heading from the task list,
  including skeletons. Reduce the table's minimum width by 40px; keep internal
  task IDs, accessible row positions and file/status/progress sorting.

## Verification

- `npm run ui:check` and `npm test`.
- `go test ./...` and `go vet ./...` from `truedown`.
- `npm run test:viewport` from `truedown/desktop`: continuous scrolling, delayed
  reads, return-before-response races, placeholder geometry, animated/static
  screenshot comparison, bounded task nodes and desktop/narrow layouts.
- `npm run test:settings` from `truedown/desktop`: delayed category reads,
  automatic recovery, light/dark themes, reduced motion, search, navigation,
  drafts and save feedback at three widths.
- `npm run test:workspace` from `truedown/desktop`: sorting, selection, retained
  focus, navigation and layout at normal and enlarged scale.
- `npm run test:feedback` from `truedown/desktop`: sticky group actions remain
  aligned during the settings reveal, held at its midpoint for a timing-independent
  geometry check.
- Browser fixtures verify layout and animation; native compositor acceptance
  and release publication remain separate.
