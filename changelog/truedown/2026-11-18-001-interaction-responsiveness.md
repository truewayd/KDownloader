# Improve window and workspace responsiveness

- Skip redundant caption and WebView clipping updates during ordinary Windows window moves. Keep native dragging, snapping and animation timings.
- Batch filename fitting and reuse task rows when only queue statistics change.
- Update sidebar group dragging once per frame and skip redundant dropdown hover updates.
