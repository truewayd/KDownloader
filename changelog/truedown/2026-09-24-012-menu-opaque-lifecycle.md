# TrueDown: opaque Fluent menu surfaces and completed-layout styling

- Preserve the preceding Acrylic build in commit e5d8188 before revising it.
- Remove the unstable Acrylic/extended-glass and alpha-buffer implementation.
  Use a neutral opaque surface, subtle hover, aligned icon column and measured
  top/bottom padding. Disable popup DWM transitions to avoid black fade frames.
- Bind styling with WH_CALLWNDPROCRET after native creation/positioning returns,
  instead of reentering the window procedure during WM_WINDOWPOSCHANGING. Keep
  native row measurement and menu tracking responsible for pointer hit regions.
- Debug diagnostics include the last selected row, popup bounds and cursor
  position so any remaining displacement can be compared in screen coordinates.

## Verification

- Windows debug build and test-target compilation succeed; tests were not run.
- User acceptance is still required for pointer alignment, opaque menu styling
  and dismissal. Previous Acrylic acceptance reported misaligned hover and a
  black exit animation; this note does not claim those were visually retested.
