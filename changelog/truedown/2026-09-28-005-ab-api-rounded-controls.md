# ABDM compatibility and consistent rounded controls

- Reviewed ABDM v1.10.4 and current integration source. Accept legacy arrays,
  typed HTTP sources, suggested filenames and explicit download-start flags.
- Honor silent add without starting transfers; persist the paused state across
  restart and resolver expansion without changing duplicate task identity.
- Expose the empty named-queue list and reject unsupported HLS, category and
  named-queue requests instead of silently applying different behavior.
- Align buttons, inputs, selectors, navigation, tabs, menus and panels around
  shared larger corner radii while retaining pill searches and joined controls.
- Match Windows native menu hover corners to the shared 10px menu-item radius.
- Apply the same subtle workspace shadow to new-download, task-detail and log
  panels; leave room around the log surface so its shadow remains visible.
- Keep tooltips below native caption controls to prevent the Windows titlebar
  from clipping their text.
- Direct backend root requests return plain-text 405 Method Not Allowed;
  unknown paths still return 404 and API authentication stays unchanged.

## Verification

- API compatibility fixtures cover legacy and current requests, rejected types,
  initial state, authentication and backend root responses.
- Manager tests cover paused engine admission, batch expansion, duplicate
  identity and restart persistence; full Go tests and vet.
- UI acceptance covers light/dark themes, narrow settings, task forms, details,
  selectors, auxiliary windows and caption-safe tooltips at 100-200 percent scale.
- Repository tests, component synchronization, extension build and Linux tests.
