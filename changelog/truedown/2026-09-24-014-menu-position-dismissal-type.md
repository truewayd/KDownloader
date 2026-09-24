# TrueDown: menu positioning, immediate dismissal and typography

- Preserve the reviewed frame6 baseline at 6c1ba16. User acceptance confirmed
  improved styling but still reported pointer/display displacement.
- Move DWM frame application out of WM_WINDOWPOSCHANGED entirely. Even after
  DefSubclassProc returns, its native positioning call has not yet unwound.
  Apply styling through a later uniquely ticketed owner message; ignore stale
  or hidden popups. Keep native sizing and pointer geometry unchanged.
- Filter activation in the native menu loop: validate the current highlighted
  row and, for mouse activation, its native screen rectangle; record the fixed
  command and end/hide the menu before USER32's selected-item fade path. Escape
  and caller cancellation also dismiss immediately. Keep per-popup DWM
  transitions disabled and leave global Windows preferences untouched.
- Align opaque menu typography with the main UI: 14px regular, Microsoft YaHei
  UI for Chinese and Segoe UI Variable Text/Segoe UI for shortcuts, with installed
  font fallback and larger accessibility text preserved. Honor system smoothing
  instead of forcing grayscale. GDI/WebView rasterization is not pixel-identical.
- Frame7 debug diagnostics record pre/post styling rectangles and actual pointer
  events against native/compositor bounds to distinguish positioning from stale
  selected-row redraws. Diagnostics remain bounded and contain no menu text.

## Verification

- Windows debug build and test-target compilation only; no tests or interactive
  acceptance executed, as requested. User acceptance remains necessary for
  pointer alignment, dismissal through each input path, and text appearance.
