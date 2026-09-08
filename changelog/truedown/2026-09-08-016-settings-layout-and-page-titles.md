# Clearer page titles and settings layout

TrueDown removes the repeated main-page heading, auxiliary page banners and
native download-form headings while retaining accessible page names. Native
window and browser titles no longer append the product name. The main sidebar
no longer shows an exit button; the native tray still provides Exit. Batch
download now shares the task toolbar with queue and refresh actions.

Settings use consistent spacing, top-aligned fields and balanced file-option
rows. File suffixes follow a five-column desktop or two-column mobile grid.
Module and engine cards give their actions a separate row, and API Key settings
use the same checkbox controls as other categories. Explanatory text focuses on
choices and effects instead of internal implementation details.

Google Drive and Dropbox module cards use the shared provider icons and retain
their version, current state, update actions and errors without lengthy metadata.

Verification covers desktop and mobile Chromium in both color schemes, all
settings categories, aligned file selectors, scrolling and keyboard access,
draft retention, save success/failure, module toggles and native task forms.
The Node regression suite, component/icon checks, Go tests/vet and Windows Rust
tests pass. Hidden WebView2 acceptance covers all six native windows, title-bar
controls, task forms, retained drafts, light/dark materials, accessibility
fallbacks, recovery and exit cleanup.

The rebuilt Windows production package passes hidden startup, matching
shell/core/CLI identity and graceful exit checks. Its ZIP passes native archive
content and executable validation.
