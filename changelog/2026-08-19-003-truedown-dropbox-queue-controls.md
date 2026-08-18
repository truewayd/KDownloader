# Optional Dropbox expansion and queue controls

- Made Dropbox shared-folder parsing an explicit per-submission choice. Direct archive download is the default, while expanded submissions can independently enable or disable the persisted suffix filter.
- Limited project-file filtering to TrueDown's Dropbox expansion path; ordinary KDownloader media tasks are no longer removed by those rules.
- Reduced large-folder latency by crawling sibling Dropbox directories with bounded parallelism and bulk-importing the extracted files into the task manager instead of adding each fresh task through a separate lock cycle.
- Added a persisted simultaneous-download setting backed by aria2 global options. It defaults to 3 and applies immediately without restarting TrueDown.
- Added whole-queue pause/resume controls, a host download-directory action, and a completed-task file action. Path APIs resolve server-owned directories or task IDs and never accept arbitrary client paths.
- Added server-side ascending/descending sorting across filtered task pages for ID, file name, status, link, and progress, controlled by accessible table-header buttons.
- Centralized dashboard controls on one embedded SVG icon sprite, keeping TrueDown offline-capable without a runtime CDN or frontend package build.

## Verification

- `npm test`
- `python -m unittest tests/migrate_history_json_test.py`
- `go test ./...`
- `go vet ./...`
- `pwsh -NoProfile -ExecutionPolicy Bypass -File build.ps1`
