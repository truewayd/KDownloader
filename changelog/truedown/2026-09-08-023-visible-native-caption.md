# TrueDown 1.6.2

- Remove the remaining one-pixel top inset from restored Windows frames. The client now reaches the window's top edge, allowing DWM to draw its real minimize, maximize and close controls while the application supplies the title content.
- Tighten hidden-window geometry acceptance to require zero top inset and add explicitly opted-in visual acceptance for main, settings, new-task and batch-task windows. Capture only the fixture's own windows and check contrast in each native caption glyph.
- Reset Playwright's default color-scheme emulation when verifying the actual system theme. The application already follows Windows; the test driver must not force it to light mode.

## Verification

- Visible Windows acceptance: all four window roles display all three native caption glyphs and follow the operating-system theme.
- Full hidden Windows acceptance, Rust tests and Clippy.
- Node tests, Go tests/vet and Windows package startup.

## Implementation reference

- [Microsoft: Custom Window Frame Using DWM](https://learn.microsoft.com/en-us/windows/win32/dwm/customframe): fully extend the client into the caption, retain native DWM controls and delegate non-client input.
