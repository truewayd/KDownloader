# Native workspace, task windows and sharper icons

TrueDown now groups download status navigation in a collapsible sidebar and
places logs, settings and about in its bottom utility area. The task workspace
uses a compact header, quieter queue controls, searchable filters and more room
for progress. Narrow screens retain reachable tools and horizontally scrollable
task actions. Filtering, sorting and polling preserve row controls and focus.

Windows and Linux use an integrated title bar with minimize, maximize/restore,
drag and hide controls. Windows retains its native system menu and keyboard/drag
snapping; macOS keeps native traffic lights in an overlay title bar. Mica,
light/dark colors and opaque accessibility fallbacks remain coordinated.

New-download and batch-download forms are independent singleton native windows
that retain drafts when hidden and refresh the main task view after submission.
Their roles have bounded API access and never poll task pages. The browser keeps
in-page dialogs. Low-frequency headers and retry overrides are grouped under
advanced options. File selection uses explicit choose/clear actions and readable
file names; task forms and settings can use a parented system directory picker.
Cancel and late picker results preserve existing drafts.

An architecture review also fixed cancelled bridge requests retaining pending
slots, queued writes delaying shutdown, and concurrent exits returning before
cleanup. Request frames release their payload allocation after writing; failed
or cancelled partial writes invalidate the pipe before another writer proceeds.
Native forms refresh complete preference snapshots on activation and submission
without resetting edits or adding task polling. macOS focus changes replace the
existing material view instead of accumulating native views.

Tauri capabilities grant only event subscriptions and window inspection. The
default permission group no longer exposes arbitrary local image reads or
direct menu/tray mutations; native actions use the constrained Rust commands.
Hidden Windows smoke tests poll readiness from the driver at a fixed bounded
interval because WebView animation frames and page timers may be suspended.

Release validation now bounds ZIP/TAR metadata before parsing, rejects ambiguous
ZIP names and unsupported archive formats, and preserves normal GNU/PAX package
layouts. Root-directory ZIP entries are rejected consistently with the native
updater. License downloads enforce their limit while streaming, and generated
notice inventories enforce the cumulative limit before retaining more text.

Both products generate SVG icons from pinned Lucide sources, also used for
native menu icons. Native brand rasters are rendered directly at each DPI size.
The ICO begins with its 256px layer because Tauri loads its first layer as the
window icon; the earlier 16px-first ordering caused taskbar upscaling. Windows
now has 17 exact-size rasters and macOS includes Retina representations. Source
licenses ship with the generated sprites and TrueDown notices.

## Verification

All 304 Node regressions, 27 release-validator tests, deterministic icon/component
checks and the extension clean build passed. Browser acceptance covers desktop
and mobile layouts in both themes at 100% and 200% DPI, actual wheel/keyboard
interaction, sorting, filter synchronization and focused-row retention. Native
form checks cover file choice/clear, directory cancellation, late results,
retained drafts and submission without task polling.

Rust tests passed on Windows (17) and Linux (16), with formatting and Clippy
warnings denied. Linux's six WebKit windows were exercised inside Xvfb with
nonzero viewports, including activation after module/default changes. Its final
amd64 production package passed startup, core/CLI identity, graceful exit and
actual tar.gz archive validation. Packaged frontend files matched the source.

Final Windows hidden WebView2 acceptance passed for six singleton windows,
retained drafts, role permissions and the rejected image-read command, task
creation refresh, private authentication, scale/layout, DWM material/theme state
and solid accessibility fallbacks. Core recovery, external exit and shell-crash
cleanup passed with every native window hidden. Its final amd64 production
package passed startup, core/CLI identity and graceful exit; the actual ZIP and
PowerShell-generated schema-2 update manifest passed file and hash validation.

Windows maximize-button hover Snap layouts are not implemented; keyboard and
drag snapping remain available. macOS native rendering requires its CI host.
