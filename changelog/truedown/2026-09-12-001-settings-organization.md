# TrueDown settings organization

- Consolidate twelve sidebar categories into eight: Download and speed (including network), File management (including groups), Application and connections, Engine and modules, Advanced, Experimental, Logs, and About. Previous category URLs remain compatible.
- Save download and network defaults together while separating new-task defaults from live queue controls within the page.
- Group network settings by retries, proxy connection, and request identity; explain defaults, limits, and when changes apply.
- Separate file writing and integrity options from Dropbox expansion and suffix filtering. Keep group editing on the same page with explicit independent save controls; file-option saves and resets preserve group drafts.
- Clarify resolver modules, application and engine updates, advanced parameter format, and browser-extension authentication setup.
- Retain category-scoped saves, drafts, and the inset save footer. Validate light/dark layouts at desktop and mobile widths with the existing browser acceptance fixture.

No API, storage, or default-value changes.

## Verification

- `node truedown/desktop/tests/settings-browser-smoke.mjs`
- `node truedown/desktop/tests/auxiliary-ui-browser.mjs`
- `node truedown/desktop/tests/file-groups-browser-smoke.mjs`
- `npm run ui:check`
- `npm test`
