# TrueDown: bind native menu styling before display

- Move popup discovery from WM_DRAWITEM/WM_ENTERIDLE to a temporary hook on
  the caller's UI thread. Match the exact active HMENU before attaching the
  frame subclass; buffered drawing contexts need not expose a popup HWND.
- Configure the frame before the native show and suppress the legacy shadow
  before it creates a separate window. Restore the class flag and release the
  hook/subclass on teardown. Keep native input and activation behavior intact.
- Remove reentrant frame resizing during painting and guard nested messages
  while applying DWM attributes.
- Debug builds write a bounded menu-frame-diagnostics.log beside the binary
  after menu dismissal, recording binding, DWM result, frame paint count and
  shadow creation count. No menu text, clipboard or profile values are logged.

## Verification

- Windows debug build compiles successfully.
- Earlier shadow-flag and nonclient-paint builds failed user visual acceptance.
  This lifecycle correction is pending user acceptance; no desktop automation
  or interactive tests were run, as requested.
