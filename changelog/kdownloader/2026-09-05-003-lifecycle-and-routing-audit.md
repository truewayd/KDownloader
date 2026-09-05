# KDownloader 1.2.4 - lifecycle and routing audit

Creator Fetch now keeps the selected Coomer origin throughout post downloads.
Concurrent TrueDown rule synchronization and Watch alarm replacement preserve
the order of saved settings and report failed side effects.

The creator-cache bridge discards stale responses after XHR reuse, event-handler
reentry or page cleanup and refreshes its enabled state after bfcache restoration.
Content download controls recover from pagehide cleanup without retaining a
permanent sending state. History-import notifications refresh Pawchive and
Favorites through the shared route watcher, and history lookups remain within
the RPC batch limit on large pages.
Native action hosts now reflect busy state consistently with their Shadow DOM
buttons, including Favorites and Watch controls.

## Verification

Added deterministic regressions for origin routing, external side-effect order,
XHR/IndexedDB lifecycle, content cleanup and large-page history lookups. The full
audit results and environment coverage are recorded in
`docs/project-reaudit-2026-09-05.md`.
