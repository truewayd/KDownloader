# Integrated native sidebar and consistent navigation

The Windows and Linux main window shares its caption row with the sidebar logo
and collapse control. The draggable caption starts beside the sidebar and follows
its expanded or collapsed width. macOS keeps space for its native traffic lights.

Main and settings navigation share neutral hover surfaces, a short inset selection
marker and accent-colored icons. Hover and selection preserve control geometry,
keyboard focus and high-contrast indicators.

## Verification

Browser acceptance covers light and dark navigation, expanded and collapsed
caption boundaries, pointer reachability, retained task polling focus and settings
categories at desktop and mobile widths. Component and icon consistency checks,
Node regression tests, Go tests/vet and Windows Rust tests pass.
Hidden Windows WebView2 acceptance covers all six native windows, both themes,
high-contrast and reduced-transparency fallbacks, recovery and exit cleanup.
