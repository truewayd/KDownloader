# KDownloader render lifecycle and shared UI performance

- Retire pending render results immediately after history/HTMX changes, including replacements at the same URL.
- Suspend route observation and scheduling on pagehide, then resume the existing watcher on pageshow. Slow renders drain the latest requested refresh without repeated polling timers.
- Coalesce shared tooltip layout updates per animation frame and cancel queued work on dismissal.
- Add isolated real-extension checks for the 360px action popup in both themes, Shadow DOM controls, keyboard focus, history/HTMX reinjection and page lifecycle on all supported site families and Favorites.

## Verification

Focused lifecycle regressions, full Node suite, Python migration tests, clean extension build, real Chromium extension settings and action-popup checks. Site fixtures are synthetic; they do not certify current live-site markup or successful media downloads.
