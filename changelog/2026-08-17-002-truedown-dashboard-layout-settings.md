# TrueDown dashboard layout and download defaults

- Moved download defaults and API Key controls from the dashboard sidebar into a focused settings modal, giving the task list the full dashboard width.
- Added browser-local defaults for the download folder, per-task connections and speed, retries, proxy, User-Agent, Referer, request headers, file allocation, integrity checks, remote timestamps, and additional safe aria2 options.
- Constrained the desktop dashboard to the visible viewport and made the task list the dedicated scroll region, with sticky table headings, compact scrollbars, and responsive mobile fallbacks.
- Preserved keyboard focus trapping, Escape and backdrop dismissal, reduced-motion behavior, and focus restoration for both download and settings dialogs.

## Verification

- `node --check truedown/web/app.js`
- `go test ./...`
- `go vet ./...`
