Purpose
-------
- This document defines repository layout, conventions, and collaboration rules for agents and developers.
- It prescribes concrete steps for splitting content scripts, batching downloads, minimizing storage writes, and integrating third-party downloaders safely.
- When a user proposes adding a feature, update this file to reflect API, manifest, config, storage, and test changes.

Repository structure (current)
------------------------------
- background/: MV3 service worker modules.
- content/: content script modules.
- popup/: popup UI and scripts.
- icons/: icon assets.
- content.css: injected UI styles.
- manifest.json: extension manifest and content script injection order.

Key background modules
----------------------
- background/index.js is the service worker entry.
- background/constants.js holds CONFIG, storage keys, alarm names, and the canonical API object.
- background/util.js contains sanitizeFileName, getFileExtension, extractExternalLinks, and buildDownloadTasks.
- background/db.js implements cached history DB lookup, batch downloaded-state checks, writes, and lastAccess helpers.
- background/config.js implements favorites/backend/gist helpers.
- background/network.js centralizes fetch and cookie handling.
- background/download.js implements startFullDownload, runSequentialDownloads, and backend batching.
- background/messages.js is a thin message router.
- background/messageHelpers.js and background/progress.js hold shared message/progress utilities.
- background/handlers/*.js implements focused RPC groups for config, DB, downloads, creator cache, and utilities.

High-level goals for agents
---------------------------
- Keep content scripts small, deterministic, and load-order safe.
- Minimize chrome.storage writes by batching and flush-on-idle or threshold flush.
- Chunk large file lists and limit concurrency to avoid overwhelming backends and external downloaders.
- Implement robust messaging with ack, progress, complete, timeouts, and heartbeat.

API centralization
------------------
- Expose a single API object in background/constants.js.
- Include API.HOSTS, API.DEFAULT_ORIGIN, API.API_PREFIX, and endpoint suffixes.
- Background modules must import { API } and build URLs from API fields.
- Injected/page scripts must declare only small local constants and must not import extension modules.
- When endpoints change, update background/constants.js and search for local duplicates to update.

Content script splitting and injection
--------------------------------------
- Organize content/ into helpers.js, ui.js, download.js, router.js, and page-specific action scripts.
- Maintain injection order in manifest.json: helpers -> ui -> download -> router -> actions.
- New content/*.js files must be added to manifest.json in correct order.
- content/router.js owns stable reinjection scheduling for history navigation, pageshow, visibility, MutationObserver, and HTMX events.
- Page-specific action scripts must register idempotent renderers with KDRouteWatcher and avoid patching history directly.
- Avoid a single bootstrap file; test reloads and HTMX swaps to ensure no ReferenceError or duplicate buttons.

Message patterns and timeouts
-----------------------------
- Use safeSendMessage for retries and configurable timeouts.
- Background must ack long-running requests synchronously with { accepted: true }.
- Background must emit periodic progress messages and a final completion message.
- Content scripts must implement a watchdog that resets on progress and applies a generous timeout window.

Batching and storage write policy
---------------------------------
- Avoid per-file storage writes.
- Use markMultipleDownloaded on batch completion or an in-memory buffer with periodic flush.
- Expose markDownloaded, markMultipleDownloaded, checkDownloaded, and checkDownloadedMany RPCs; prefer markMultipleDownloaded and checkDownloadedMany for groups.
- Keep downloaded history in the background DB cache after first load; do not re-read the whole chrome.storage.local downloaded object for each post lookup.
- On sync quota failures, schedule retries via chrome.alarms (SYNC_VERSION_ALARM).

Third-party and backend downloader policy
-----------------------------------------
- Enforce per-post file limits (perPostFileLimit, default 100).
- Use bounded worker pools (configurable concurrency, default 3).
- Insert small spacing between file dispatches and between batches.
- Implement per-file retry with backoff and aggregate results.
- Report progress after each dispatch to keep watchdog alive.
- Fallback to chrome.downloads when backend dispatch fails.
- Gopeed integration must use background REST fetch with Content-Type: application/json and X-Api-Token headers; do not use no-cors because it strips required headers.
- Move network and paging logic to background for Creator Fetch and Page Fetch.

Recommended batching implementation
-----------------------------------
- Build file tasks with UTIL.buildDownloadTasks.
- Split tasks into batches sized by perPostFileLimit.
- Consume each batch with a worker pool using an atomic index.
- Increment global counters after each dispatch and emit progress.
- Pause between batches to avoid bursts.
- Aggregate dispatch results and return them to the caller.
- Call markDownloaded or markMultipleDownloaded after confirmed successful dispatches.

Global progress and UI
----------------------
- Background must aggregate active batch progress per-post and emit globalProgress messages.
- Expose status.getGlobalProgress for snapshot queries.
- Popup must subscribe to globalProgress and display a realtime top-position progress bar when total > 0.

Testing and validation
----------------------
- Unit test utility functions where feasible.
- Include manual integration tests covering single-post download, Page Fetch, progress behavior, and DB batching.
- Simulate slow backends and failures to validate watchdogs and fallbacks.
- Document manual test steps and expected outcomes in PR descriptions.

Commits and PRs
---------------
- Keep changes minimal and focused.
- Include tests or manual test steps in PR descriptions.
- Document new configuration keys and storage fields in this file.
- Note backward-incompatible message shapes and migration steps in PRs.

Conventions and style
---------------------
- Use async/await and robust error handling.
- Centralize cookie access, downloads, and DB writes in background modules.
- Minimize DOM work in content scripts and use efficient selectors.
- Prefer module-based design and avoid unnecessary window pollution.
- Update manifest.json for any added content scripts and verify injection order.

Cleanup and dead code
---------------------
- Remove unused imports and duplicate imports.
- Archive or delete unused files only after cross-repo reference checks.
- Run linter and unit tests before opening PRs.
- Update this file's changelog when removing or archiving files.

Contact and changelog
---------------------
- Add notes in PRs for backward-incompatible changes.
- Record configuration keys added to storage and brief migration notes here.
- When a user proposes adding a feature, update this file to document the feature scope, required API changes, manifest updates, configuration keys, and test steps.
- 2026-07-01: Refactored background message routing into background/handlers modules, added cached downloaded DB batch lookup via checkDownloadedMany, added content/router.js for HTMX-aware reinjection, and updated manifest injection order to include router.js before download and favorite-flag page action scripts. No storage migration required.
- 2026-07-01: Updated Gopeed backend compatibility to use the REST API with token header support and optional gopeedPath stored in backendConfig. No migration required; missing gopeedPath defaults to empty.
- 2026-07-01: Cleanup pass removed empty coomerfans.md, removed duplicated flag-page message helper/debug logging, removed stale debug mutation from creator cache refresh, and kept injected/creators_page.js because it is dynamically injected by content/injector.js. No storage migration required.
