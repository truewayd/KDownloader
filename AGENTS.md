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
- manager.py is an optional local SQLite converter for exported history JSON. It must preserve the legacy posts table and use history_posts(collection, platform, author, post_id) for the current downloaded/coomerfansDownloaded split.

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
- Keep non-API-compatible site origins, such as API.COOMERFANS_ORIGIN, in the API object without adding them to API.HOSTS when they should not use the shared /api/v1 or creators override flows.
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
- coomerfans.com creator-page injection lives in content/coomerfans_actions.js and targets section.model-posts .posts-list .post on /u/{platform}/{creator_id}/{creator_name} pages. Post-page injection targets article.text-block.model-info on /p/{post_id}/{creator_id}/{platform} pages and inserts the button after the platform tag row. It must use platform, creator_id, and post_id inside the dedicated coomerfansDownloaded history store and treat creator_name as optional filename metadata.
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
- For coomerfans.com popup Creator Fetch, discover post links from /u/{platform}/{creator_id}/{creator_name}, extract media from each /p/{post_id}/{creator_id}/{platform} HTML page, and store downloaded history in chrome.storage.local coomerfansDownloaded under platform -> creator_id -> post_id. Creator name is optional metadata for filenames only.
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
- Popup Creator Fetch is a top-level panel, independent from backend configuration accordions. When backend is not configured and enabled, show a Settings shortcut button and communicate the backend requirement through the input placeholder rather than a click-time alert.
- Advanced configuration lives in settings.html, opened by Chrome's extension Options entry via manifest options_ui. Reuse background RPCs for backend, batching, Gopeed, Favorites, Gist, and creators cache settings instead of writing storage directly.
- Popup should stay minimal: Creator Fetch plus a History panel for import/export by default. The button becomes a Settings shortcut when backend is disabled. Search Page Fetch cache buttons are shown only when enabled in settings.html, Gist buttons only when Gist Sync is enabled, and destructive history clear actions belong in settings.html.
- Settings backend configuration shows only backend enable/type until enabled, then reveals only the selected backend's fields plus shared batching controls. Gopeed download path is not supported.
- Settings must provide a Restore defaults action for advanced configuration. It should reset backend, Favorites, Gist, and Search Page Fetch settings without clearing downloaded history.

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
- CoomerFans popup Creator Fetch scope: manifest host permissions include coomerfans.com; background/constants.js exposes API.COOMERFANS_HOST and API.COOMERFANS_ORIGIN; popup accepts https://coomerfans.com/u/{platform}/{creator_id}/{creator_name}; background discovers post pages and extracts /storage/ media from HTML. Downloaded history is stored separately in coomerfansDownloaded, and import/export/Gist payloads contain both downloaded and coomerfansDownloaded. Test with a coomerfans.com creator URL, verify global progress, backend dispatch, and downloaded history keys using platform/creator_id/post_id.
- 2026-07-01: Refactored background message routing into background/handlers modules, added cached downloaded DB batch lookup via checkDownloadedMany, added content/router.js for HTMX-aware reinjection, and updated manifest injection order to include router.js before download and favorite-flag page action scripts. No storage migration required.
- 2026-07-01: Updated Gopeed backend compatibility to use the REST API with token header support. gopeedPath support was later removed from the UI and dispatcher. No migration required.
- 2026-07-01: Cleanup pass removed empty coomerfans.md, removed duplicated flag-page message helper/debug logging, removed stale debug mutation from creator cache refresh, and kept injected/creators_page.js because it is dynamically injected by content/injector.js. No storage migration required.
- 2026-07-01: Added popup Creator Fetch support for coomerfans.com using HTML listing/post parsing based on download.py. Manifest gained coomerfans.com host permissions. No storage migration required.
- 2026-07-01: Added coomerfans.com content-script injection for /u/{platform}/{creator_id}/{creator_name} creator pages, including per-post downloaded status buttons and current-page batch dispatch. Manifest injection order includes helpers, ui, download, router, then coomerfans_actions.js. No storage migration required.
- 2026-07-01: Moved popup Creator Fetch out of the backend accordion into a top-level panel. The fetch button becomes a Settings shortcut until backendConfig.enabled is true, with the input placeholder explaining the backend requirement. No storage migration required.
- 2026-07-01: Added settings.html/settings.css/settings.js as a Chrome options page for advanced configuration, including backend, batching, Gopeed, Favorites, Search Cache, and Gist settings with inline SVG icons. Manifest now declares options_ui.open_in_tab. No storage migration required.
- 2026-07-01: Reduced popup to daily actions: Creator Fetch, optional Search Page Fetch cache buttons, optional Gist Sync buttons, and import/export. Clear History moved to settings.html. Added gistConfig.enabled to control whether Gist Sync appears in popup; missing enabled defaults to false, so no migration required.
- 2026-07-01: Adjusted settings.html for responsive advanced settings: backend fields are conditional on enable/type, all feature switches use Enable wording, Gist has a dedicated save button, and popup height is content-driven to avoid vertical scrolling. No storage migration required.
- 2026-07-01: Added Restore defaults to settings.html for advanced configuration only; downloaded history is intentionally preserved. No storage migration required.
- 2026-07-01: Removed obsolete popup accordion/backend control styles after moving advanced configuration to settings.html, removed an unused settings SVG symbol, unused theme variables, and nonessential refresh/debug logs, and tightened popup storage-change listeners to avoid refreshing feature visibility on progress updates. No storage migration required.
- 2026-07-01: Split CoomerFans downloaded history into chrome.storage.local coomerfansDownloaded, separate from downloaded used by Kemono, Coomer, and Pawchive. Import/export and Gist Sync now serialize both downloaded and coomerfansDownloaded in one JSON payload. No backward compatibility migration required.
- 2026-07-01: Updated manager.py for the split history export format. It imports both legacy flat JSON and the new {downloaded, coomerfansDownloaded} shape, exports the new shape, stores records in history_posts with a collection key, and leaves the legacy posts table intact for database safety.
