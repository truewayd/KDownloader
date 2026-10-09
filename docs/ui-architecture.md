# UI component architecture

## Download preview

TrueDown uses one resizable native preview window so the download workspace remains usable.
Its compact toolbar contains fit/actual-size/zoom controls and explicit file, application chooser
and directory actions. The central media canvas and footer expose the same Mica surface as the
caption, with the shared solid/high-contrast fallback. Toolbar actions use the canonical icon
sprite and accessible names/tooltips; narrow windows collapse file-action labels and wrap groups.
Image wheel input zooms around the pointer from 5% to 800%, and dragging pans overflow inside
the canvas. Keyboard +/-, 0 and F provide zoom, actual size and fit; other preview kinds retain
normal scrolling. Audio/video never autoplay. Task target revisions discard
stale reads, and hiding the window pauses playback and releases blob URLs.

The preview loads only packaged UI and bounded task-owned bytes. See
[`preview-security.md`](../truedown/docs/preview-security.md) for format, resource, IPC and path boundaries.

## Decision

The repository uses one canonical component runtime, `shared/components.js`,
with two deliberate DOM modes:

- Extension-owned pages and the TrueDown dashboard keep native controls in
  Light DOM. These documents already own their CSS boundary, and native
  `button`, `input`, `select`, `textarea`, `label`, and form behavior must stay
  intact.
- Controls injected into third-party pages use Shadow DOM. Host-page CSS can
  position a component host but cannot restyle its internal control, status
  animation, focus ring, or external-links dialog.

Putting every control in Shadow DOM is not a design goal. A shadow-wrapped
form control is outside its surrounding form's normal tree and would require a
second implementation of submission, validation, label association, and focus
behavior. The hybrid boundary provides isolation without replacing browser
semantics.

## Sources and distribution

`shared/components.js` is the only manually edited component runtime. It owns:

- busy-button concurrency and state restoration;
- toast lifecycle;
- asynchronous native confirmation dialogs for extension-owned pages;
- progress rendering;
- page loading structure and busy state, with field and list variants;
- segmented-control state;
- icon accessibility normalization;
- the injected action control; and
- the injected external-links dialog.

Popup, settings, and content scripts load that file directly. Go's `embed`
patterns cannot include a parent directory, so TrueDown embeds the generated
byte-for-byte mirror at `truedown/web/components.js`. Run `npm run ui:sync`
after changing the canonical source. `npm run ui:check`, the Node test suite,
and the TrueDown release build reject a stale mirror.

`shared/ui.js` contains only extension transport behavior and exposes the
canonical component helpers through `KDUI`. TrueDown calls `KDComponents`
directly.

## Component boundaries

### Reuse and derived variants

Related controls share the canonical behavior first, then derive intentional style
or interaction differences through explicit options, states and scoped styles.
Do not duplicate a component to change its appearance, or erase intentional
layout, dimensions and hierarchy merely to merge implementations.

`KDComponents.setPageLoading` owns one idempotent placeholder and `aria-busy`
state. TrueDown settings, new-download defaults and task details use its field
variant; the initial task list uses its list variant. Their appearance and shared
content reveal live in `ui-baseline.css`, including reduced-motion behavior.
Category headers, retry messages, navigation and existing drafts remain owned
by their pages. Background refreshes retain already loaded content. The virtual
list retains its measured row placeholders, and file preview retains byte-read
progress: those provide layout and progress information specific to their jobs.
None of these content effects replaces a native window transition.

### Caption tooltip composition

TrueDown keeps tooltips in the canonical DOM/popover controller, including text,
keyboard dismissal, pointer transit and `aria-describedby`. The controller emits
`kd-tooltip-layout` with viewport-relative bounds or null on dismissal. Windows'
native-frame adapter serializes/coalesces those layouts through caller-scoped
`frame_tooltip` IPC. A new document opens a native session; old sessions and
revisions cannot overwrite a newer layout. The native frame unions only the
tooltip's rounded footprint into the WebView region, retaining the resize edge
and caption exclusions elsewhere. Native move/resize/activation/hide and page
navigation clear the reveal. CSS-to-client ratios account for DPI and WebView
zoom. Without a working adapter, placement retains the caption-safe top inset.

This follows the composition approach observed in the locally installed Codex
26.924.2738.0 Windows package: its main bundle configures Electron's hidden
title bar and title-bar overlay; renderer bundles use Radix Tooltip/Portal.
That evidence establishes a DOM tooltip above window chrome, not a separate
native tooltip window. TrueDown uses its existing Tauri/WebView2 frame instead
of importing Electron or replacing Windows caption controls. Native screenshots
must validate final composition; browser screenshots alone omit DWM controls.

### Light DOM

Owned documents use the shared `kd-*` vocabulary:

- `kd-panel` for surfaces;
- `kd-button` and `kd-icon-button` for native buttons;
- `kd-input`, `kd-select`, and `kd-toggle` for native form controls;
- `kd-segmented` and `kd-segment` for grouped choices;
- `kd-progress`, `kd-loading`, and `kd-toast` for feedback; and
- `kd-hidden` for explicit visibility state.

TrueDown block guidance and persistent status feedback use `kd-notice`, prepared
by `KDComponents.prepareNotices()` from explicit `data-kd-notice="info|warning|error"`
elements. An optional `data-kd-notice-title` supplies the heading. The shared
runtime retains the original message node, IDs, live-region semantics and links;
repeated preparation is idempotent. TrueDown's `ui-baseline.css` owns the single
icon/content layout, semantic surfaces, wrapping and focus treatment. Empty or
hidden messages hide their whole surface, and `data-error="true"` on a dynamic
message switches to the error treatment. Keep short field constraints as hints,
and keep actionable update cards, the sidebar monitor and transient toasts in
their existing components.

Advanced aria2 task parameters belong beneath the download core in Engine and
modules, including autosave and category reset. Dropbox's directory and filter
controls live inside its module card; the same form nodes survive module list
refreshes. Module switches and package actions save independently. Disabled
modules retain their preferences, and direct archive mode disables filter editing.
Engine and modules reset also resets Dropbox defaults; File management reset
resets the save directory, file writing and verification, preserving group edits
and existing files. Dropbox's project-filter link
uses the existing group route and focuses the editor with smooth scrolling;
reduced motion uses immediate scrolling. Ordinary task rows display the matched
group icon in a compact surface, including custom icons; unknown groups use the
file fallback. Update tasks retain their updater indicator.

Download and network contains transfer limits, proxy, request headers and retry
defaults, distinguishing immediate queue controls from defaults for new tasks.
File management owns the save directory alongside file writing and group
directories. Application and connections orders startup/tray, browser/API
connection, then data storage; connection instructions share their parent's
surface. About keeps program updates separate from engine/module updates.

File group persistence uses the versioned document described in
[`file-groups.md`](file-groups.md). UI snapshots are ordered views, not the on-disk
format; icons are materialized by the core rather than inferred from group names.

Page CSS may define layout, density, and responsive placement. It must not
redefine the shared extension-page tokens or component behavior. TrueDown
keeps its standalone CSS artifact, with effective light/dark theme equality enforced by tests.

The form controls share font inheritance, selector arrows, focus rings, and
disabled/hover behavior. Select arrows survive focus and disabled states;
checkboxes keep a visible keyboard focus indicator. Compact dashboard buttons
and the 360px popup retain their deliberate density. Progress track/fill visuals
belong to `shared/ui.css`; popup CSS controls their placement only.

Extension pages request confirmations through `KDUI.confirmAction`, which
creates a text-only native `dialog` with the shared palette and buttons. The
browser owns modality, and the shared controller explicitly contains Tab and
Shift+Tab focus within the dialog. Cancel receives initial focus;
Escape, backdrop clicks, and the cancel button resolve `false`. Closing restores
focus after the caller can release its busy control. TrueDown uses parented
native confirmation dialogs. Its bundled frontend uses private IPC and does
not provide browser login or API Key storage; browser layout fixtures retain
the accessible page dialog for isolated UI checks.

Busy helpers update `aria-busy` and `aria-disabled` together. `withBusyButton`
restores both prior attributes once overlapping operations have settled;
`setBusyState` can temporarily announce `busyLabel` without replacing visible
button text. Native control disabled state remains the source of truth when a
caller manages availability itself.

### Shadow DOM

`kd-ui-action` is the only injected action host. Its `variant` attribute is
`action`, `creator`, or `flag`; state is carried by `data-status`,
`data-watched`, and `data-flag`. The shadow tree always contains a native
button, so keyboard and accessibility behavior remain browser-owned.
Callers create or recover the host through the canonical action factory. It
first uses the registered Custom Element when Chrome upgrades the node. Chrome
can leave a content-script-created node unupgraded in an isolated world, so the
same factory can also hydrate that host imperatively with the same open Shadow
root, native button, attribute bridge, and canonical styles. It then audits
connected controls for the expected display and cursor plus the overlay circle
and background. A failed audit installs the same canonical CSS as a local
Shadow-root style fallback instead of exposing an unstyled custom element.

`kd-ui-links-dialog` owns URL rendering, backdrop/Escape close, focus trapping,
focus restoration, motion reduction, and cleanup. Callers validate and bound
URLs before handing them to the component, and create it through the canonical
dialog factory. The dialog uses the same shared controller in upgraded and
imperatively hydrated hosts, so an isolated-world upgrade failure cannot
silently suppress the modal or fork its behavior.

`content.css` is intentionally layout-only. It may establish a positioning
context or host-specific placement, but all visual component CSS lives inside
the canonical Shadow DOM runtime.

Shadow DOM does not isolate the custom-element host box from third-party page
CSS. `content.css` therefore owns the authoritative geometry, pointer hit area,
and cursor for overlay action hosts with scoped, important declarations. The
shared mount helper preserves containers that already have non-static
positioning, adds a relative context only to static containers, and releases
its marker classes when the final overlay action is removed. This keeps route
swaps and hostile generic site selectors from moving or disabling controls.

## TrueDown visual baseline

Task selection uses a bottom floating action bar inside the task workspace, with
clear-selection focus restoration and enough scroll clearance for the last row.
It never changes the virtual viewport height. A single navigation indicator moves
between file groups with a 320 ms cubic-bezier transition; reduced motion disables
it. Search controls share a 36 px height, icon inset and explicit clear control.
Native material navigation uses alpha overlays for hover and selection. Toasts
transition both in and out, hiding hit targets as soon as dismissal starts.
Ordinary borders stay at 1 px with low contrast; the floating selection surface
has no decorative outline. Keyboard focus and forced colors retain clear edges.
The add-group action sticks to the settings scrollport edge after passing it.
Updater-owned tasks expose a durable `updateDownload` marker, a purpose label and
animated transfer icon. Individual, selected and whole-queue pause/removal flows
explain update consequences; completed downloads do not imply installation.

`truedown/web/ui-baseline.css` is the authoritative product theme, loaded by
the main/settings/task pages and independent confirmation/menu pages. The base
primitives retain the shared extension token contract; this single product
layer supplies the reference neutral surfaces used by extension pages and injected Shadow DOM controls. `native-appearance.css` owns OS frame
and material integration only. Page styles own layout, not alternate palettes.

Windows information, warning and danger confirmations expose Mica continuously
from caption to content and footer. Settings, new-download and task-detail
windows retain their opaque working surfaces. Custom native frames extend only
the caption height, preserving DWM caption composition and the WebView's
caption-control exclusion; Mica backdrop attributes are applied separately.
Standard-caption confirmations use a full-client extension and may invoke only
their own material update alongside initialization, readiness and answering.
Reduced transparency, high contrast and unsupported systems retain the solid
fallback. Native HMENU surfaces retain their separate opaque rendering policy.

- Neutral light/dark surfaces; retain the teal brand accent for active actions.
- System fonts; body 14px, controls/menu labels 13px, section headings 15px,
  category headings 24px. Ordinary controls use weight 500, headings 600.
- Spacing follows 4/8/12/16/24/32px. Controls are normally 36px tall; menus use
  34px rows and 16px icons. Compact toolbars may use 32px controls.
- Both products use 12px control corners, 16px panel/modal corners and 10px
  list-item corners. Extension tokens in `shared/ui.css` follow TrueDown's
  `ui-baseline.css`; injected controls apply the same baseline inside Shadow DOM.
  Joined input/select controls round only their outside corners. Use whitespace and surface
  tones for grouping. No decorative panel outlines, button shadows or repeated
  separators. Editable fields and visible keyboard/high-contrast focus retain
  necessary boundaries; popup separation may use the OS-owned shadow.
- Search fields use pill corners. Main and settings navigation share a 216px
  expanded width and the same narrow-screen widths; collapsing the main sidebar
  does not collapse settings navigation.
- Native settings, new-task and task-details windows use fixed preferred client
  sizes of 960x760, 660x560 and 640x640 logical pixels. Confirmations use a 440px
  width and content-measured height. Auxiliary windows cannot be manually resized
  or maximized; native placement may still shrink them to fit the monitor.
- Task details use compact information/settings tabs, transfer facts, an overall
  progress bar, an optional piece map and a connection table. File locations and
  links remain selectable in an expandable section. aria2 `tellStatus` supplies
  byte counters and an MSB-first completed-piece bitmap; `getServers` supplies
  per-connection speed, not per-connection byte totals or confirmed resume support.
  Show unavailable data explicitly rather than inventing connection ranges.
- The task toolbar orders search, status, pause, resume, retry, completed cleanup
  and a right-aligned directory button. Narrow content hides retry and cleanup.
  Sidebar notices prioritize updates, then show icon-based global downloading/error
  counts and speed only while downloads are active. Group badges count all tasks
  regardless of the current filters.
- Sidebar width changes animate over 220 ms and respect reduced motion. Expanded
  traffic places speed before the right-aligned counts; collapsed traffic shows
  speed alone in an 88 px desktop rail (80 px at narrow widths). Update notices
  retain their priority and compact icon/progress presentation.
- TrueDown hover descriptions use the canonical `installTooltips` controller and
  `data-tooltip`, never browser `title` bubbles. Short labels use a compact dark
  surface; long details and errors use a theme-aware card. Keyboard focus,
  Escape, hoverable content, viewport fitting and stale-anchor cleanup are shared.
- The list has no visible pagination. A bounded 100-row window with overscan
  follows scrolling, reuses task rows and refreshes through conditional reads.
  Global overview counters are maintained at task mutation boundaries.
  Scroll reads are coalesced per animation frame, including cancellation of a
  pending jump when returning to the loaded window. Unloaded spacers repeat a
  single 64px skeleton tile measured from the real row's responsive geometry.
  A moving gradient highlights its shapes without creating additional task
  nodes; reduced motion selects a static tile. Resize and theme changes refresh
  the measured tile.
  Task rows omit display ordinals; internal task IDs still own selection and
  actions, while ARIA row indices retain the logical position in the full list.
- Use one generated Lucide icon system. Icon-only actions require accessible
  labels. The category reset is a small icon next to its heading. Settings
  headings scroll with content; saving is automatic, with no floating save bar.
- Settings help is concise and visible by default, never hidden behind a generic
  disclosure. Search indexes all authored help and field labels before profile
  reads; runtime status and user values are excluded. Simple settings opt into
  the two-column `settings-row` layout. File-group editors, suffix selections
  and multiline fields retain stacked labels and adapt to the content width.
  File groups use separate cards and editable suffix chips backed by the existing
  string array. Keep the add-group action visible above the list, and preserve
  focused inputs across autosave. Navigation clips horizontal overflow during
  sidebar transitions; pointer sorting uses an inert floating preview and a
  placeholder, with cancellation restoring the confirmed order.
  Initially unread categories keep their controls inert and transparent until
  all category snapshots have been applied. Loading and retry feedback remains
  visible, and navigation stays available. Completed categories reveal together
  over 180ms using opacity only, preserving sticky and focus geometry throughout
  the animation; reduced motion reveals them immediately. Cached visits retain
  controls and drafts, and stale category completions cannot change the active
  category's presentation.
- Do not repeat a purpose icon in both native caption and content. Windows
  confirmation frames omit the caption icon; warning/error content has one
  severity icon, while informational content needs none. macOS keeps the single
  content icon. Linux content omits an extra icon because window-manager
  decorations may already supply one. Native utility windows retain their
  role icon without duplicating it in an interior heading.
  Confirmation content uses the whole native material surface when available
  (Mica on Windows, vibrancy on macOS), with the existing accessibility/unsupported
  fallback. Measure natural content before sizing; only bounded long messages
  scroll, while the action footer stays visible.
- A native window title names its purpose once. Do not repeat that title as a
  visible heading inside the window; show explanatory detail and actions there.
  Hidden accessible headings may remain. Distinct category titles inside the
  Settings window are appropriate because they convey another level.
- Information/warning/danger prompts are separate parented native WebView
  windows. Context menus use native HMENU on Windows and parented WebViews on
  other desktops, styled with this same baseline. Windows owner drawing keeps
  native input and labels; high contrast uses the stock menu. DWM rounds the
  frame; the popup subclass replaces the stock beveled nonclient inset with the
  menu surface while excluding all client content from that paint pass. Menu
  creation/initial positioning is observed by a temporary owning-thread call
  hook which attaches a popup subclass. Suppress the legacy class shadow before
  display, restoring its flag on teardown. WM_WINDOWPOSCHANGED posts an owner
  message with a unique ticket; only that later dispatch may query the exact
  HMENU and set DWM visual attributes. Returning from DefSubclassProc is still
  inside native positioning and does not make synchronous styling safe.
  Stale tickets and hidden popups are ignored. The return hook did not observe system-menu messages in
  user acceptance; querying/styling during pending positioning risks reentrancy.
  Painting-time DC lookup is unreliable for buffered menus. Preserve native nonclient
  layout policy and disable menu slide animation so visual and hit rectangles
  stay aligned. Prefer a top-left anchor (opens right); let native work-area
  fitting move the popup left/up at monitor edges.
  Menus use a near-white/dark opaque surface, a subtle gray outline, DWM rounded
  corners and shadow, subtle hover, 4px vertical outer padding
  included in native row measurements, and a single icon column. Acrylic and
  full-frame glass are disabled: native menu dismissal did not reliably retain
  their alpha and produced black fade frames. Disable DWM popup transitions
  without changing the user's global animation or transparency preferences.
  A scoped menu message filter validates native highlighted rows and pointer
  rectangles, records mouse/Enter/Space activation, and ends/hides the menu
  before USER32 can create a selected-item fade snapshot. Native arrows and
  hit testing are retained. Chinese labels use the baseline's YaHei UI at 14px
  regular, Latin shortcuts prefer Segoe UI Variable Text/Segoe UI, and missing
  fonts fall back to the system menu font. Keep larger accessibility text and
  system font smoothing; do not force grayscale on opaque surfaces. GDI and
  WebView text rasterization can still differ slightly.
  Page modals are a
  browser-fixture fallback only; compact pickers and transient toasts may remain
  in-page. A failed native request must never approve an action or fall back to
  a page modal.
- Popup pages stay small and avoid application initialization or polling.
  Intent-based warm windows are bounded, expire after 60 seconds and are consumed
  once. Display only after content is ready; keep cancellation and request
  ownership intact when optimizing latency.

Check light/dark and narrow layouts, actual Windows popup HWND ownership,
keyboard dismissal and native editing delivery. Browser screenshots establish
layout only, not native composition or delivery on other operating systems.

Platform references: [Windows secondary dialogs](https://learn.microsoft.com/en-us/windows/win32/uxguide/win-dialog-box#title-bars)
explicitly omit caption icons; [Apple alerts](https://developer.apple.com/design/human-interface-guidelines/alerts)
allow an alert icon on macOS; [GNOME dialogs](https://developer.gnome.org/hig/patterns/feedback/dialogs.html)
emphasize a clear message, parent ownership and specific action labels. The
Linux icon placement above is our cross-window-manager choice, not a GNOME rule.

## Change rules

### Windows auxiliary-window lifecycle

Settings, new-task and task-details retain their WebView documents when closed.
On a visible desktop, reopening a hidden auxiliary window replaces only its
native shell so Windows can supply its normal opening transition. The same
document is moved through one hidden parking window; it is not navigated or
reloaded. Native close-to-hide remains responsible for the closing transition.
There are no application animation frames or `AnimateWindow` substitutes.

Reattachment preserves the role label, icon, position and measured client size.
Restore the frame subclass and the last requested material/color scheme before
showing the new HWND: DWM backdrop attributes do not follow a moved WebView,
and a retained document need not receive another DOM focus event. Re-evaluate
system transparency and high contrast through the ordinary material policy.
Failed shell setup retains the document for the next open attempt. The main
window, native menus, and non-Windows window lifecycles are unchanged.

`node truedown/desktop/tests/windows-reopen-visual.mjs --visible` runs an isolated
debug fixture and saves compositor-frame crops in its temporary directory.
It verifies document/draft retention, DWM attributes, caption clipping, icons and
client size across light, dark and emulated forced-color reopens. Inspect its
screen frames for composition; attribute assertions alone do not prove animation
or Mica rendering, and overlapping desktop windows can obscure screen captures.
Add `--layout-only` to check native task-detail gutters without cycling themes.
Ordinary `test:windows` acceptance remains hidden.

### Download preview controls

The download preview switches its toolbar by content type. Image zoom is hidden for
text and media; text uses a selectable reading surface with optional line wrapping.
`preview-player.js` owns the audio/video controls over blob-backed media elements:
seek, time/buffer state, play/pause, ten-second steps, volume/mute, speed and video
fullscreen. Controls remain visible in a separate bottom surface instead of covering
the image; audio uses a compact, centered music identity and filename. Follow the
existing teal accent, neutral alpha surfaces, system typography and control radii.
The window and toolbar retain the native material background.

Media controls use labelled buttons and keyboard-accessible ranges. Player shortcuts
apply only when focus is outside a control, so arrows and Space retain normal input
and button behavior. Fullscreen is user-initiated and may fail with an actionable
message; exiting, hiding or replacing a preview aborts listeners and releases media.
Do not add native playback controls, autoplay, external poster art or decoder plugins.
See the [media API](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement)
and [custom player guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Audio_and_video_delivery/cross_browser_video_player).

### Shared component changes

- Add reusable behavior to `shared/components.js`, not page scripts.
- Keep business logic, RPCs, and host DOM discovery outside components.
- Do not add a second injected button or dialog implementation.
- Do not duplicate the canonical runtime by hand; regenerate the TrueDown
  mirror.
- Preserve native Light DOM controls unless a component has no surrounding
  form semantics and requires a third-party CSS isolation boundary.
- Keep focus, reduced motion, light/dark tokens, and status states covered by
  `tests/uiConsistency.test.mjs`.
