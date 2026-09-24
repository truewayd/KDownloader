# UI component architecture

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

### Light DOM

Owned documents use the shared `kd-*` vocabulary:

- `kd-panel` for surfaces;
- `kd-button` and `kd-icon-button` for native buttons;
- `kd-input`, `kd-select`, and `kd-toggle` for native form controls;
- `kd-segmented` and `kd-segment` for grouped choices;
- `kd-progress`, `kd-loading`, and `kd-toast` for feedback; and
- `kd-hidden` for explicit visibility state.

Page CSS may define layout, density, and responsive placement. It must not
redefine the shared extension-page tokens or component behavior. TrueDown
keeps its standalone CSS artifact, with token equality enforced by tests.

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

`truedown/web/ui-baseline.css` is the authoritative product theme, loaded by
the main/settings/task pages and independent confirmation/menu pages. The base
primitives retain the shared extension token contract; this single product
layer supplies neutral desktop surfaces. `native-appearance.css` owns OS frame
and material integration only. Page styles own layout, not alternate palettes.

- Neutral light/dark surfaces; retain the teal brand accent for active actions.
- System fonts; body 14px, controls/menu labels 13px, section headings 15px,
  category headings 24px. Ordinary controls use weight 500, headings 600.
- Spacing follows 4/8/12/16/24/32px. Controls are normally 36px tall; menus use
  34px rows and 16px icons. Compact toolbars may use 32px controls.
- Controls have 6px corners; panels have at most 8px. Use whitespace and surface
  tones for grouping. No decorative panel outlines, button shadows or repeated
  separators. Editable fields and visible keyboard/high-contrast focus retain
  necessary boundaries; popup separation may use the OS-owned shadow.
- Use one generated Lucide icon system. Icon-only actions require accessible
  labels. The category reset is a small icon next to its heading. Settings
  headings scroll with content; saving is automatic, with no floating save bar.
- Do not repeat a purpose icon in both native caption and content. Windows
  confirmation frames omit the caption icon; warning/error content has one
  severity icon, while informational content needs none. macOS keeps the single
  content icon. Linux content omits an extra icon because window-manager
  decorations may already supply one. Native utility windows retain their
  role icon without duplicating it in an interior heading.
- A native window title names its purpose once. Do not repeat that title as a
  visible heading inside the window; show explanatory detail and actions there.
  Hidden accessible headings may remain. Distinct category titles inside the
  Settings window are appropriate because they convey another level.
- Information/warning/danger prompts and context menus are separate parented
  native WebView windows, styled with this same baseline. Page modals are a
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

- Add reusable behavior to `shared/components.js`, not page scripts.
- Keep business logic, RPCs, and host DOM discovery outside components.
- Do not add a second injected button or dialog implementation.
- Do not duplicate the canonical runtime by hand; regenerate the TrueDown
  mirror.
- Preserve native Light DOM controls unless a component has no surrounding
  form semantics and requires a third-party CSS isolation boundary.
- Keep focus, reduced motion, light/dark tokens, and status states covered by
  `tests/uiConsistency.test.mjs`.
