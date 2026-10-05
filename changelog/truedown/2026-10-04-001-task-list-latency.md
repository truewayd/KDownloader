# Faster task lists and timely progress updates

- New viewport reads can bypass a slow previous read. A bounded page cache and directional prefetch make nearby and return scrolling immediate when data is available.
- A separate bounded change wait refreshes the visible list after core updates without the extra 2.5-second polling delay. Timed recovery remains available.
- Separate core, order and row versions keep cached ranges coherent and avoid retransmitting rows for overview-only changes.
- Reuse row controls and placeholder geometry during progress updates. File-group status pagination no longer sorts the entire matching group; indexed counts allow unsearched pages to stop scanning once full.
- Preserve hidden-view suspension, selection, focus, pending actions, fixed row heights and reduced-motion placeholders.

## Verification

- Task-page scheduler, API revision/wakeup and existing frontend behavior tests.
- 2,400-task browser fixture at 1200px, 960px and 390px, including blocked old reads and change notification timing.
- Go tests/vet, Rust tests, shared UI mirror and repository tests.
