# TrueDown: workspace navigation and independent service startup

- Split downloads, application logs, and settings into directly accessible pages. Settings now includes an overview, categories, independent loading and saving, and drafts retained while navigating.
- Keep task rows and their controls during polling. Progress changes update text in place, and task polling stops outside the visible task page. Retain ETag, stale-response, selection, focus, and pending-operation protections.
- Add opt-in Windows login startup in Settings > Startup and runtime. It registers the current user, preserves the data directory, and starts in the tray without opening a browser. Unsupported configurations report their limitations.
- Add `TrueDown ui`, `TrueDown serve`, and `TrueDown background`, with `--data-dir`. All modes share the existing Go core, API, task database, and instance lock. `serve` runs without a tray or browser.
- Separate frontend transport, workspace navigation, task-row rendering, settings, and logs into focused files. Document the remaining work for a Go core plus CLI/browser/Tauri architecture in `docs/truedown-core-and-tauri.md`.

The release introduces `/settings/startup`; it does not introduce a Tauri dependency or a replacement download engine.

## Verification

- Go tests, go vet, Node regressions, and component synchronization.
- Packaged Windows service download/exit smoke and WSL Linux integration tests.
- Desktop/mobile browser checks for navigation, scrolling, focus, and task refresh.
