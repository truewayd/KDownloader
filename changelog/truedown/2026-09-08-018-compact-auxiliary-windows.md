# Compact About window and consistent window closing

The About window uses a compact product header and aligned version information,
with a smaller default window size and a panel that fills the available space.
Spacing adapts to the minimum window height without clipping its contents.

About and native download forms use the existing window close control and keyboard
shortcuts instead of repeating close buttons within their content. Download drafts
remain available when the native form is reopened. Browser dialogs retain their
cancel actions.

## Verification

Browser acceptance checks the default and minimum About window sizes in light
and dark schemes with Windows, macOS and Linux frame layouts. Caption buttons and
Escape/Ctrl+W/Cmd+W continue to close the window. Native download forms pass wheel,
keyboard, draft-retention, preference refresh and submission checks at 200% DPI.
Hidden Windows WebView2 acceptance verifies native windows, retained drafts,
task creation, materials, recovery and cleanup. The rebuilt Windows ZIP passes
archive content and executable validation.
