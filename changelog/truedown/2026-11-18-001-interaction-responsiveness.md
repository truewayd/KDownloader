# Improve window and workspace responsiveness

- Skip redundant caption and WebView clipping updates during ordinary Windows window moves. Keep native dragging, snapping and animation timings.
- Batch filename fitting and reuse task rows when only queue statistics change.
- Update sidebar group dragging once per frame and skip redundant dropdown hover updates.

## Verification

- Node and Chromium regression tests passed for frame commands, virtual scrolling, task refreshes, group sorting and dropdown input.
- The release pipeline runs native desktop and packaged startup checks on Windows, Linux and macOS.
