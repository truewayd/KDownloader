# TrueDown 1.6.1

- Initialize the extended Windows caption backing surface with zero-alpha pixels so the native minimize, maximize and close controls can be composited above it. Refresh the frame after activation, resizing, DPI and theme changes.
- Start the settings navigation 18 pixels from the top without an extra title-strip gap. Retain category order, the default Download and speed page, and the single rounded content surface.
- Test native painting in process against a real GDI bitmap. Hidden-window geometry and WebView screenshots alone cannot establish that DWM caption glyphs are visible.

## Verification

- Native caption paint regression, full Rust tests and Clippy.
- Hidden Windows acceptance with light/dark, high-contrast and reduced-transparency cases.
- Desktop/mobile settings layout, navigation hit targets, keyboard and wheel input.
- Node tests, Go tests and vet, shared UI/icon/version checks and packaged Windows startup.
