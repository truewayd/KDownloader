# TrueDown: flatten the native menu's nonclient border

- Replace the stock menu's beveled nonclient border with the menu background;
  keep DWM rounding and exclude menu items from the frame painting pass.
- Apply the same frame paint on nonclient, client and activation redraws so
  native repainting cannot restore the old right/bottom beveled edge.
- Remove the previous menu-class shadow flag workaround, which did not resolve
  the lines in user acceptance. Keep styling scoped to the current popup HWND.

## Verification

- Windows debug build compiles successfully.
- No interactive tests were run, as requested. The new border rendering still
  requires user visual acceptance.
