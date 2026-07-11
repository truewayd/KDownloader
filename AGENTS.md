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
- background/db.js owns the IndexedDB download-history database, transactional batch checks/writes, import/export, statistics, and lastAccess helpers.
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
- Keep non-API-compatible site origins, such as API.COOMERFANS_ORIGIN, in the API object without adding them to API.HOSTS when they should not use the shared /api/v1 or creators override flows.
- Background modules must import { API } and build URLs from API fields.
- Injected/page scripts must declare only small local constants and must not import extension modules.
- When endpoints change, update background/constants.js and search for local duplicates to update.

Content script splitting and injection
--------------------------------------
- shared/i18n.js owns cached Chrome i18n lookup and one-pass static DOM localization. Locale catalogs live in _locales/en and _locales/zh_CN.
- Organize content/ into helpers.js, ui.js, download.js, router.js, and page-specific action scripts.
- Maintain injection order in manifest.json: helpers -> shared/i18n -> ui -> download -> router -> actions.
- New content/*.js files must be added to manifest.json in correct order.
- content/router.js owns stable reinjection scheduling for history navigation, pageshow, visibility, MutationObserver, and HTMX events.
- Page-specific action scripts must register idempotent renderers with KDRouteWatcher and avoid patching history directly.
- coomerfans.com creator-page injection lives in content/coomerfans_actions.js and targets section.model-posts .posts-list .post on /u/{platform}/{creator_id}/{creator_name} pages. Post-page injection targets article.text-block.model-info on /p/{post_id}/{creator_id}/{platform} pages and inserts the button after the platform tag row. It must use source=coomerfans with platform, creator_id, and post_id for the normalized IndexedDB history identity and treat creator_name as optional filename metadata.
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
- markDownloaded accepts one normalized record object with identity, status, counts, and timestamp; callers should not construct legacy nested storage objects.
- Persist download history in IndexedDB rather than chrome.storage.local. Keep configuration and lightweight revision/progress signals in Chrome storage only.
- Use IndexedDB database kdownloaderHistory version 3. The legacy records store uses compound keyPath [source, service, userId, postId]. Large/current datasets live in generation-keyed importRecords with importSessions holding the active-generation pointer and import metadata. Stores use only their compound primary keys; unused creator, status, and sessionId secondary indexes were removed. Import commit must switch the active generation in O(1), never copy every staged record into records.
- Store one normalized history record per source/service/user/post identity. Records contain source, service, userId, postId, status, totalCount, successCount, failedCount, and updatedAt; supported statuses are partial, complete, and empty.
- Preserve the legacy shared namespace for all non-CoomerFans sites: Kemono, Coomer, and Pawchive use source=default. Only CoomerFans uses source=coomerfans. This keeps migrated downloaded records query-compatible despite the legacy format not storing an origin/source field.
- Perform grouped reads and writes in a single IndexedDB transaction.
- Serialize history mutations through the database transaction boundary so imports, clears, and download completion writes cannot overwrite one another.
- Expose db.stats for popup statistics. Active generations must return the maintained receivedRecords/receivedBytes metadata in O(1); never scan or count hundreds of thousands of IndexedDB rows just to render popup statistics. Popup refreshes these values from the history revision signal instead of observing legacy history keys.
- Never send a complete history JSON through chrome.runtime messaging. Popup import uses db.import.begin/chunk/commit/abort with byte-bounded chunks (currently 4 MiB) and persistent generation storage; popup export pins a generation with db.export.begin, reads it through db.export.page, and assembles the Blob incrementally. Keep individual payloads well below Chrome's 64 MiB message limit.
- Import must reject duplicate `[source, service, userId, postId]` identities within the same generation, including duplicates split across chunks. Return a user-visible `Duplicate history identity` error containing the conflicting identity and leave the active history unchanged.

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
- For coomerfans.com popup Creator Fetch, discover post links from /u/{platform}/{creator_id}/{creator_name}, extract media from each /p/{post_id}/{creator_id}/{platform} HTML page, and store normalized IndexedDB records keyed by source=coomerfans, platform, creator_id, and post_id. Creator name is optional metadata for filenames only.
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
- Test IndexedDB batch marking, partial/complete/empty status semantics, concurrent writes, clear/import exclusion, db.stats, and multi-megabyte histories. Fire-and-forget backend acceptance is treated as complete because the cross-origin downloader cannot provide a reliable final completion callback.
- Test large chunked imports, retry idempotency, abort behavior, O(1) generation commit, mark-vs-commit transaction ordering, generation-pinned paginated export, and response-level RPC failures. The existing live history must remain unchanged until import commit succeeds.
- Test O(1) stats after large imports plus exact metadata deltas for new records, overwrites, and mixed batch upserts. Test migrated default-source records from Pawchive pages as downloaded.
- Test that version 3 has no secondary indexes and that same-chunk/cross-chunk duplicate identities abort import without changing live history. Identical postId values under different source/service/userId identities remain valid.
- Export history and verify the JSON schema/version plus all normalized record fields; import that file into an empty database and verify record identities, statuses, counts, and popup statistics match.
- Legacy chrome.storage.local downloaded and coomerfansDownloaded objects are intentionally not migrated because the extension has not been released. Test with a clean extension profile after this change.
- migrate_history_json.py is an offline-only developer utility for converting legacy exported JSON to schemaVersion 2. It must remain independent from extension runtime code; validate it with python -m unittest tests/migrate_history_json_test.py.
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
- 2026-07-11: Added Chrome MV3 localization with English as the default locale and Simplified Chinese in _locales/zh_CN. Manifest metadata, popup, settings, and injected content UI use shared/i18n.js with cached lookups; no API, config, or storage migration required. Validate with node --test tests/i18n.test.mjs and manual locale switching in Chrome.
- When a user proposes adding a feature, update this file to document the feature scope, required API changes, manifest updates, configuration keys, and test steps.
- CoomerFans popup Creator Fetch scope: manifest host permissions include coomerfans.com; background/constants.js exposes API.COOMERFANS_HOST and API.COOMERFANS_ORIGIN; popup accepts https://coomerfans.com/u/{platform}/{creator_id}/{creator_name}; background discovers post pages and extracts /storage/ media from HTML. IndexedDB records identify CoomerFans entries with source=coomerfans plus platform/creator_id/post_id. Test with a coomerfans.com creator URL and verify global progress, backend dispatch, and the normalized history identity.
- 2026-07-11: Replaced chrome.storage.local downloaded/coomerfansDownloaded history blobs with kdownloaderHistory IndexedDB. Version 3 uses generation-keyed importRecords plus an active-generation pointer in importSessions, with no secondary indexes. The new database starts empty and deliberately performs no legacy storage migration. History export/Gist JSON schemaVersion 2 contains schemaVersion, exportedAt, and records; each record contains source, service, userId, postId, status, totalCount, successCount, failedCount, and updatedAt. Large popup imports use 4 MiB begin/chunk/commit messages; every record is written once and commit atomically switches the active-generation pointer instead of copying hundreds of thousands of rows. Exports pin and page one generation to stay below Chrome's 64 MiB message limit. Popup statistics use generation metadata. Backend acceptance remains fire-and-forget and is recorded complete because cross-origin integrations cannot reliably report final disk completion.
- 2026-07-11: Added migrate_history_json.py as an offline-only converter from the legacy downloaded/coomerfansDownloaded export shape to schemaVersion 2 records. Legacy boolean markers become complete records with zero file counts because the old format did not preserve per-file totals. This does not add runtime migration or compatibility code to the extension.
- 2026-07-11: Restored the legacy non-CoomerFans shared history namespace by using source=default for Pawchive as well as Kemono/Coomer. This fixes migrated legacy downloaded records being missed on Pawchive pages. Active-generation db.stats now reads maintained metadata in O(1), and mark upserts adjust record/byte metadata by the old-to-new delta instead of scanning the sessionId index.
- 2026-07-11: Removed the unused creator/status/sessionId secondary indexes in IndexedDB version 3. Generation reads now use compound primary-key ranges. Import explicitly rejects duplicate source/service/userId/postId identities within or across chunks and reports the conflicting identity while preserving the active generation.
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
- 2026-07-03: Added automatic light/dark theme switching for non-injected extension UI via CSS prefers-color-scheme tokens in popup/popup.css and settings.css, preserving the existing warm Claude-like dark palette and adding a matching warm light palette. No manifest, API, config, or storage migration required.
- 2026-07-03: Added settings-page-style inline SVG icons to popup action buttons and kept Creator Fetch's dynamic Settings/Fetch label icon-aware. No manifest, API, config, or storage migration required.
- 2026-07-05: Added pawchive.pw as a Pawchive-equivalent domain. Manifest host permissions and content-script matches now include pawchive.pw, and background Pawchive downloads resolve the origin from the sender page so pawchive.st and pawchive.pw share the same storage/source behavior. No storage migration required.
