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
- background/config.js implements Pawchive Watch/backend/gist helpers and owns the global downloadRulesConfig suffix-filter settings.
- background/pawchive.js owns pawchive.pw creator-page and single-post JSON requests plus file-task parsing.
- background/watch.js owns the Pawchive-only watch list, alarm scheduling, profile comparisons, and aggregated notifications.
- background/nativeFallback.js owns session-persistent backend-failure prompts and their two-button notification payloads.
- background/network.js centralizes fetch and cookie handling, including Cloudflare-aware Pawchive API routing and challenge notifications.
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
- Pawchive integrations use the separate PAW object. PAW.HOST and PAW.ORIGIN are fixed to pawchive.pw, PAW.API_PREFIX is /api/v1, and PAW.FILE_ORIGIN is https://file.pawchive.pw. Do not reintroduce pawchive.st host permissions or runtime fallbacks. Pawchive JSON requests must use network.fetchPawchiveJson so Cloudflare session routing and block detection remain consistent.

Content script splitting and injection
--------------------------------------
- shared/i18n.js owns cached Chrome i18n lookup and one-pass static DOM localization. Locale catalogs live in _locales/en and _locales/zh_CN.
- Organize content/ into helpers.js, ui.js, download.js, router.js, and page-specific action scripts.
- Maintain injection order in manifest.json: the standalone Pawchive API bridge at document_start, then helpers -> shared/i18n -> ui -> download -> router -> actions for page UI.
- New content/*.js files must be added to manifest.json in correct order.
- content/router.js owns stable reinjection scheduling for history navigation, pageshow, visibility, MutationObserver, and HTMX events.
- Page-specific action scripts must register idempotent renderers with KDRouteWatcher and avoid patching history directly.
- coomerfans.com creator-page injection lives in content/coomerfans_actions.js and targets section.model-posts .posts-list .post on /u/{platform}/{creator_id}/{creator_name} pages. Post-page injection targets article.text-block.model-info on /p/{post_id}/{creator_id}/{platform} pages and inserts the button after the platform tag row. It must use source=coomerfans with platform, creator_id, and post_id for the normalized IndexedDB history identity and treat creator_name as optional filename metadata.
- content/paw_actions.js runs only on https://pawchive.pw/{service}/user/{creator_id} pages. Creator pages expose an idempotent manual Watch/Unwatch button in .user-header__actions; post pages must not expose the Watch button. Watch state is read and mutated only through background watch.* RPCs.
- content/paw_api_bridge.js runs at document_start on https://pawchive.pw/* and accepts only same-origin /api/v1/ GET requests from the extension. Background Pawchive API calls prefer this bridge so Cloudflare sees the verified page context; the bridge must never accept arbitrary origins, paths, methods, or browser-controlled identity headers.
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
- Offer chrome.downloads only after the user confirms the backend-total-failure notification.
- Gopeed integration must use background REST fetch with Content-Type: application/json and X-Api-Token headers; do not use no-cors because it strips required headers.
- Move network and paging logic to background for Creator Fetch and Page Fetch.
- When an enabled backend accepts zero files for a post or batch, do not fall back silently. Persist the native-fallback task descriptors in chrome.storage.session under pendingNativeFallbacks and show one requireInteraction notification with Continue download and Cancel download buttons. Continue uses chrome.downloads and writes history only after confirmed dispatch; cancel or notification dismissal emits a cancelled completion and never writes history. Do not prompt after partial backend acceptance because retrying the whole task set would duplicate accepted files.

Recommended batching implementation
-----------------------------------
- Build file tasks with UTIL.buildDownloadTasks.
- creator.fetch accepts an optional mode string with default, full, and links values. It defaults to default. full skips the pre-dispatch IndexedDB downloaded-record filter and dispatches every complete/discoverable creator post while preserving normal markMultipleDownloaded history writes. links processes every complete/discoverable creator post only for external-link extraction, never dispatches media, and never writes history. The legacy fullMode boolean remains accepted for compatibility but new callers must send mode.
- For coomerfans.com popup Creator Fetch, discover post links from /u/{platform}/{creator_id}/{creator_name}, extract media from each /p/{post_id}/{creator_id}/{platform} HTML page, and store normalized IndexedDB records keyed by source=coomerfans, platform, creator_id, and post_id. Creator name is optional metadata for filenames only.
- Split tasks into batches sized by perPostFileLimit.
- Consume each batch with a worker pool using an atomic index.
- Increment global counters after each dispatch and emit progress.
- Pause between batches to avoid bursts.
- Aggregate dispatch results and return them to the caller.
- Call markDownloaded or markMultipleDownloaded after confirmed successful dispatches.
- Apply downloadRulesConfig after task names are normalized and before any ABDM, Gopeed, native-fallback, or chrome.downloads dispatch. When every task in a post is excluded, complete the UI flow without writing an empty or complete history record.
- Page Fetch and Creator Fetch aggregate every extracted HTTP(S) link from the posts they process into one UTF-8 TXT task. Sort by the complete normalized link address, deduplicate exact addresses, and declare the TXT directly through chrome.downloads without sending its data URL to ABDM or Gopeed and without creating a separate history record. If a mega.nz/mega.co.nz link has no fragment key after #, also add that link's original post URL so the user can recover the key manually.

Download suffix filtering
-------------------------
- Store suffix filtering in chrome.storage.sync under downloadRulesConfig as { enabled, excludedExtensions }. It defaults to disabled and preserves existing download behavior until explicitly enabled.
- The default selectable project-file suffixes are .psd, .clip, .sai, .sai2, .kra, .xcf, .procreate, .afphoto, .afdesign, and .blend. Normalize values to lowercase dot-prefixed suffixes and reject malformed entries.
- Exclusion matching is case-insensitive, prefers the normalized task fileName, and falls back to the URL path when fileName has no suffix. It applies consistently to Kemono, Coomer, Pawchive, and CoomerFans tasks.

Pawchive Watch and downloads
-----------------------------
- Pawchive Watch supports pawchive.pw only. Adding a watch must be a manual creator-page action and must first fetch /api/v1/{service}/user/{creator_id}/profile so its current updated value becomes the no-notification baseline.
- Store Watch configuration in chrome.storage.sync under watchConfig with intervalMinutes and checkMode. Defaults are 30 minutes and batch. checkMode=batch checks five creators concurrently per batch with a short pause between batches; checkMode=all checks all watched creators concurrently in one round.
- Store the Watch list in chrome.storage.local under pawchiveWatches as { schemaVersion: 1, watches }. Each record contains service, userId, name, updated, watchedAt, checkedAt, failedAt, and lastError. Cache JPEG data URLs separately in chrome.storage.local under pawchiveWatchIcons keyed by the normalized service/user identity; exports must not include this binary cache. Complete check rounds write the list once rather than once per creator.
- Pawchive Watch export JSON contains schemaVersion: 1, site: pawchive.pw, exportedAt, and watches. Import rejects other schemas/sites and duplicate identities, then replaces the current Watch list. Restore defaults resets Watch configuration but preserves this list.
- Adding a watch fetches and caches the creator avatar, then sends one sample notification explaining that future updates will use that format. Repeated idempotent add requests must not fetch or notify again. Removing a watch deletes its cached avatar in the same storage mutation.
- Scheduled and forced checks fetch /api/v1/{service}/user/{creator_id}/profile and notify only when updated advances beyond the stored baseline. Failed profile checks emit an aggregated failure notification and retain the previous baseline.
- Aggregate multiple updates into one notification. Select the creator with the newest updated value and use its cached avatar. Avatar cache misses fetch https://pawchive.pw/icons/{service}/{creator_id} as JPEG bytes without adding a suffix, convert it to a notification-safe data URL, and persist it for later notifications. Fall back to the extension icon if only the avatar fetch fails.
- Creator-page downloads fetch 50-post pages from /api/v1/{service}/user/{creator_id}?o={offset}, where offset is a multiple of 50. Single-post downloads fetch one object from /api/v1/{service}/user/{creator_id}/post/{post_id}.
- Pawchive post downloads accept only records with has_full === true. Incomplete records must be skipped before backend dispatch and must never be marked downloaded. Build tasks only from file and attachments entries, using https://file.pawchive.pw/data{path} and the entry name as the sanitized filename.
- Pawchive API requests first use an open, non-discarded pawchive.pw tab so verified Cloudflare cookies and the real same-origin browser context are preserved. Background fetch is only a fallback when no bridge is available. Detect cf-mitigated challenges, Cloudflare HTML/WAF responses, and blocked direct requests; show one cooldown-deduplicated requireInteraction notification with an Open Pawchive button. Users must complete verification and keep a Pawchive tab open before retrying. Do not copy cf_clearance into messages, custom headers, or logs.
- Scheduled Watch checks with no open Pawchive tab first probe the first watched profile through a silent background API request and reuse a successful response. If that probe fails, create one https://pawchive.pw tab with active=false and pinned=true, wait briefly for the document-start API bridge, then continue the check. Probe failure itself must not notify; only a subsequent bridged/background request that still detects Cloudflare verification or blocking may notify. Manual Check now does not create a tab.

Global progress and UI
----------------------
- Background must aggregate active batch progress per-post and emit globalProgress messages.
- Expose status.getGlobalProgress for snapshot queries.
- Popup must subscribe to globalProgress and display a realtime top-position progress bar when total > 0.
- Popup Creator Fetch is a top-level panel, independent from backend configuration accordions. When backend is not configured and enabled, show a Settings shortcut button and communicate the backend requirement through the input placeholder rather than a click-time alert.
- Popup Creator Fetch exposes a non-persistent mode dropdown with Default, Full, and Links only. It sends creator.fetch.mode for that request. Links only remains available when the media backend is disabled because the generated TXT is declared directly through chrome.downloads; Default and Full keep the existing backend-settings shortcut behavior. This adds no configuration key or storage field.
- Advanced configuration lives in settings.html, opened by Chrome's extension Options entry via manifest options_ui. Reuse background RPCs for backend, batching, Gopeed, Pawchive Watch, Gist, and creators cache settings instead of writing storage directly.
- Download rules use downloadRules.getConfig and downloadRules.setConfig RPCs. This feature adds no manifest permission or host access.
- Popup should stay minimal: Creator Fetch plus a History panel for import/export by default. The button becomes a Settings shortcut when backend is disabled. Search Page Fetch cache buttons are shown only when enabled in settings.html, Gist buttons only when Gist Sync is enabled, and destructive history clear actions belong in settings.html.
- Popup Site Search defaults to Pawchive and can switch between Pawchive, Kemono, Coomer, and CoomerFans. Pawchive, Kemono, and Coomer open `/artists?q={query}&sort_by=favorited`; CoomerFans opens `/?q={query}`. URL construction stays local to popup/search.js and opens a new tab. This feature adds no background API, manifest permission, configuration key, or storage field.
- Settings backend configuration shows only backend enable/type until enabled, then reveals only the selected backend's fields plus shared batching controls. Gopeed download path is not supported.
- Settings must provide a Restore defaults action for advanced configuration. It should reset backend, Pawchive Watch configuration, Gist, and Search Page Fetch settings without clearing downloaded history or the Pawchive Watch list.

Testing and validation
----------------------
- Unit test utility functions where feasible.
- Include manual integration tests covering single-post download, Page Fetch, progress behavior, and DB batching.
- Simulate slow backends and failures to validate watchdogs and fallbacks.
- Test backend-total-failure confirmation persistence, two-button notification shape, batch aggregation, atomic decision consumption, notification dismissal as cancellation, Chrome-download continuation, and the absence of history writes before continuation succeeds.
- Test IndexedDB batch marking, partial/complete/empty status semantics, concurrent writes, clear/import exclusion, db.stats, and multi-megabyte histories. Fire-and-forget backend acceptance is treated as complete because the cross-origin downloader cannot provide a reliable final completion callback.
- Test large chunked imports, retry idempotency, abort behavior, O(1) generation commit, mark-vs-commit transaction ordering, generation-pinned paginated export, and response-level RPC failures. The existing live history must remain unchanged until import commit succeeds.
- Test O(1) stats after large imports plus exact metadata deltas for new records, overwrites, and mixed batch upserts. Test migrated default-source records from Pawchive pages as downloaded.
- Test Pawchive Watch baseline creation, unchanged/newer updated comparisons, batch/all check modes, single and aggregate notifications, newest-creator avatar selection, avatar fallback, failure notifications, concurrent list mutation, alarm rescheduling, and schema/site/duplicate import rejection. Network requests in unit tests must be fully mocked.
- Test Pawchive creator-page arrays and single-post objects, 50-item offset normalization, exact file URL/name construction, attachment deduplication, and has_full=false skipping before any backend or history action.
- Test Pawchive same-origin API bridge URL/header restrictions, open-tab preference, browser-managed credentials, direct-fetch fallback, Cloudflare challenge/WAF detection, notification deduplication, and the Open Pawchive notification action.
- Test scheduled Watch startup with no Pawchive tab: successful probes are reused exactly once, failed probes are silent, the created tab is inactive and pinned, bridge readiness is awaited, and manual checks do not invoke this tab bootstrap.
- Test that version 3 has no secondary indexes and that same-chunk/cross-chunk duplicate identities abort import without changing live history. Identical postId values under different source/service/userId identities remain valid.
- Export history and verify the JSON schema/version plus all normalized record fields; import that file into an empty database and verify record identities, statuses, counts, and popup statistics match.
- Legacy chrome.storage.local downloaded and coomerfansDownloaded objects are intentionally not migrated because the extension has not been released. Test with a clean extension profile after this change.
- Test popup Site Search with all four site selections, URL-encoded search text, Enter-key submission, and empty input. Pawchive must be selected by default and every search must open a new tab with the exact site-specific URL shape.
- Test default-off suffix filtering, config normalization, case-insensitive fileName/URL matching, long project suffixes, mixed allowed/excluded tasks, and the absence of history writes when a post is fully excluded.
- Test Pawchive Creator Fetch pagination through 50-post offsets, Full mode history-filter bypass with normal post-history writes preserved, Links only media/history bypass, direct chrome.downloads TXT declaration with the backend disabled, exact-link sorting/deduplication, arbitrary HTTP(S) link extraction, and original-post insertion for MEGA links without fragment keys.
- Build an unpacked Chrome test directory with tools/build-extension.ps1. The output is dist/KDownloader and must contain only runtime files; reject Python sources/bytecode, __pycache__, and underscore-prefixed reserved paths other than Chrome's required _locales directory.
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
- 2026-07-18: Replaced the popup Creator Fetch Full mode switch with a non-persistent Default/Full/Links only dropdown and added creator.fetch.mode. Links only scans every complete/discoverable creator post for external links without media dispatch or history writes and works with the backend disabled. All Page Fetch and Creator Fetch link TXT files now use chrome.downloads directly instead of passing a data URL to ABDM/Gopeed, preventing backend "no URL to download" failures. The legacy creator.fetch.fullMode boolean remains accepted for compatibility. There are no manifest, permission, durable configuration, or storage-schema changes. Validate with node --test tests/creatorFetchMode.test.mjs tests/downloadFilter.test.mjs tests/backendFallback.test.mjs tests/downloadHistory.test.mjs tests/pawchive.test.mjs.
- 2026-07-18: Fixed popup Pawchive Creator Fetch to use the Pawchive creator JSON pagination flow instead of the Kemono/Coomer profile/posts endpoints. Added a default-off popup Full mode that bypasses downloaded-record filtering while preserving normal post-history writes. Page Fetch and Creator Fetch now aggregate processed-post HTTP(S) links into a sorted, exact-deduplicated TXT backend task; keyless MEGA links also include their source post URL. creator.fetch adds optional fullMode, and startDownloadBatch adds optional internal link-aggregation fields; there are no manifest, permission, durable configuration, or storage-schema changes. Validate with node --test tests/downloadFilter.test.mjs tests/pawchive.test.mjs tests/downloadHistory.test.mjs.
- 2026-07-17: Added default-off project-file suffix exclusion through downloadRulesConfig in sync storage and downloadRules.getConfig/setConfig RPCs. Filtering runs before all backend and native dispatch paths and fully filtered posts do not enter history. Settings expose selectable .psd/.clip and related suffixes. Added tools/build-extension.ps1 for a clean dist/KDownloader Chrome unpacked-test directory that excludes Python and reserved temporary paths. No manifest or permission change is required. Validate with node --test tests/downloadFilter.test.mjs tests/downloadHistory.test.mjs and pwsh -ExecutionPolicy Bypass -File tools/build-extension.ps1.
- Record configuration keys added to storage and brief migration notes here.
- 2026-07-16: Optimized hot paths without changing APIs or storage schemas. Global progress now maintains O(1) aggregate counters and coalesces update broadcasts to 100 ms while preserving immediate batch boundaries. Creator cache payload/metadata writes are atomic, and multi-host refresh/read/summary operations are parallel or batched. Validate with node --test --test-isolation=none tests/progress.test.mjs tests/creatorsPerformance.test.mjs.
- 2026-07-16: Added popup Site Search with Pawchive selected by default and switches for Kemono, Coomer, and CoomerFans. Pawchive/Kemono/Coomer use favorited artist-search URLs; CoomerFans uses its root query URL. No background API, manifest, permission, configuration, or storage change is required. Validate with node --test tests/popupSearch.test.mjs and manual popup searches using both the button and Enter key.
- 2026-07-14: Added Cloudflare-aware Pawchive API routing. A document-start content bridge performs restricted same-origin /api/v1/ GET requests through an open verified pawchive.pw tab before background fallback, preserving browser-managed Cloudflare cookies and page request context without copying clearance tokens. Challenge/WAF responses create one cooldown-deduplicated notification with an Open Pawchive action. Manifest adds only the bridge content script; there are no new permissions, configuration keys, or storage fields. Validate with node --test --test-isolation=none tests/pawchive.test.mjs tests/pawchiveBridge.test.mjs tests/watch.test.mjs.
- 2026-07-14: Scheduled Pawchive Watch checks now silently probe one profile when no Pawchive tab is open. A successful response is reused; a failed probe opens one inactive pinned Pawchive tab and waits for the same-origin bridge before checking. Manual checks do not auto-open tabs, and probe failures do not notify by themselves. No manifest, permission, configuration, or storage change is required.
- 2026-07-14: Replaced the placeholder Favorites watcher with Pawchive Watch for pawchive.pw only. Creator pages now provide manual Watch/Unwatch, settings configure a 30-minute default interval plus batch/all modes, and Watch JSON import/export uses schemaVersion 1. watchConfig is stored in sync storage, pawchiveWatches in local storage, and pawchiveWatchIcons caches avatar data URLs outside exports; the obsolete favoritesConfig and favoritesCheck alarm are intentionally not migrated or managed. Adding a watch sends a sample notification, update checks compare profile.updated and reuse cached avatars, and update/failure results are aggregated. Manifest Pawchive access is restricted to https://pawchive.pw and https://file.pawchive.pw.
- 2026-07-14: Replaced Pawchive HTML download scraping with JSON APIs. Creator pages use /api/v1/{service}/user/{creator_id}?o={multiple_of_50}; single posts use /api/v1/{service}/user/{creator_id}/post/{post_id}. Only file and attachments paths become https://file.pawchive.pw/data{path} tasks with API-provided names. Records with has_full !== true are skipped before dispatch and never enter download history. Validate with node --test --test-isolation=none tests/pawchive.test.mjs tests/watch.test.mjs tests/downloadHistory.test.mjs; all network calls are mocked.
- 2026-07-14: Backend total failure now pauses silent Chrome fallback and persists pending task descriptors in chrome.storage.session. A two-button notification asks whether to continue through chrome.downloads or cancel; batch failures share one prompt, dismissal cancels, and history remains unchanged until Chrome accepts files. No manifest permission or durable-storage migration is required.
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
