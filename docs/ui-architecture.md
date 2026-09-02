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
