# TrueDown: native Windows context menus and rounded framing

- Use Win32 HMENU for Windows group, task, workspace and editing actions so the
  operating system owns mouse capture, keyboard navigation and dismissal.
- Draw menu items with product colors, generated icons, aligned shortcuts and
  rounded hover backgrounds; preserve native text and high-contrast rendering.
- Request DWM rounded framing and suppress the legacy square drop shadow during
  the styled menu lifetime to address the right and bottom shadow strips.
  Restore the class setting and remove the popup subclass on teardown.
- Keep cancellation caller-bound and prevent stale cancellation from closing
  a newer menu. Windows no longer prepares unused menu WebViews.
- Adapt opt-in Windows acceptance fixtures to native menu selection.

## Verification

- Windows debug build compiles successfully.
- The preceding native-menu build passed manual group-edit and editor-selection
  checks. The final shadow adjustment has not undergone visual acceptance.
- Interactive testing is delegated to the user; no desktop automation was run
  for this adjustment. Acrylic is not enabled on the opaque GDI menu surface.
