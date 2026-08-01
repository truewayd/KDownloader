# KDownloader Changelog

The dated files in this directory contain release-ready notes. The entries below are the historical archive preserved from the former `AGENTS.md` changelog.

## 2026-08-02

- See [Component And Code Audit](2026-08-02-001-component-audit.md).

## 2026-08-01

- Added `.github/workflows/publish-extension.yml`. Pushes to `main` and manual runs build `dist/KDownloader` with `tools/build-extension.ps1`, archive it as `KDownloader-build-{run_number}.zip`, and publish a unique GitHub Release tagged `build-{run_number}`. Remote test execution is intentionally omitted; tests remain available for local validation. The workflow requires `contents: write`; no extension manifest, runtime permission, configuration key, or storage schema changes are introduced.

## 2026-07-18

- Replaced the popup Creator Fetch Full mode switch with a non-persistent Default/Full/Links only dropdown and added `creator.fetch.mode`. Links only scans every complete/discoverable creator post for external links without media dispatch or history writes and works with the backend disabled. All Page Fetch and Creator Fetch link TXT files now use `chrome.downloads` directly instead of passing a data URL to ABDM/Gopeed. The legacy `creator.fetch.fullMode` boolean remains accepted for compatibility. Validate with `node --test tests/creatorFetchMode.test.mjs tests/downloadFilter.test.mjs tests/backendFallback.test.mjs tests/downloadHistory.test.mjs tests/pawchive.test.mjs`.
- Fixed popup Pawchive Creator Fetch to use the Pawchive creator JSON pagination flow instead of the Kemono/Coomer profile/posts endpoints. Added a default-off popup Full mode that bypasses downloaded-record filtering while preserving normal post-history writes. Page Fetch and Creator Fetch aggregate processed-post HTTP(S) links into a sorted, exact-deduplicated TXT task; keyless MEGA links also include their source post URL. `creator.fetch` accepts optional `fullMode`, and `startDownloadBatch` accepts optional internal link-aggregation fields. Validate with `node --test tests/downloadFilter.test.mjs tests/pawchive.test.mjs tests/downloadHistory.test.mjs`.

## 2026-07-17

- Added default-off project-file suffix exclusion through `downloadRulesConfig` in sync storage and `downloadRules.getConfig/setConfig` RPCs. Filtering runs before all backend and native dispatch paths and fully filtered posts do not enter history. Settings expose selectable `.psd`, `.clip`, and related suffixes. Added `tools/build-extension.ps1` for a clean unpacked-test directory. Validate with `node --test tests/downloadFilter.test.mjs tests/downloadHistory.test.mjs` and the build script.

## 2026-07-16

- Optimized hot paths without changing APIs or storage schemas. Global progress maintains O(1) aggregate counters and coalesces update broadcasts to 100 ms while preserving immediate batch boundaries. Creator cache payload/metadata writes are atomic, and multi-host refresh/read/summary operations are parallel or batched. Validate with `node --test --test-isolation=none tests/progress.test.mjs tests/creatorsPerformance.test.mjs`.
- Added popup Site Search with Pawchive selected by default and switches for Kemono, Coomer, and CoomerFans. Pawchive/Kemono/Coomer use favorited artist-search URLs; CoomerFans uses its root query URL. No background API, manifest, permission, configuration, or storage change is required. Validate with `node --test tests/popupSearch.test.mjs` and manual popup searches.

## 2026-07-14

- Added Cloudflare-aware Pawchive API routing. A document-start content bridge performs restricted same-origin `/api/v1/` GET requests through an open verified pawchive.pw tab before background fallback. Challenge/WAF responses create one cooldown-deduplicated notification with an Open Pawchive action. Validate with `node --test --test-isolation=none tests/pawchive.test.mjs tests/pawchiveBridge.test.mjs tests/watch.test.mjs`.
- Scheduled Pawchive Watch checks silently probe one profile when no Pawchive tab is open. A successful response is reused; a failed probe opens one inactive pinned Pawchive tab and waits for the bridge. Manual checks do not auto-open tabs.
- Replaced the placeholder Favorites watcher with Pawchive Watch for pawchive.pw only. Creator pages provide manual Watch/Unwatch, settings configure a 30-minute default interval plus batch/all modes, and Watch JSON import/export uses schemaVersion 1. `watchConfig` is stored in sync storage, `pawchiveWatches` in local storage, and `pawchiveWatchIcons` caches avatar data outside exports.
- Replaced Pawchive HTML download scraping with JSON APIs. Creator pages use 50-post offsets and single posts use `/post/{post_id}`. Only file and attachment paths become `https://file.pawchive.pw/data{path}` tasks. Records with `has_full !== true` are skipped before dispatch and never enter history.
- Backend total failure pauses silent Chrome fallback and persists pending task descriptors in `chrome.storage.session`. A two-button notification asks whether to continue through `chrome.downloads` or cancel; history remains unchanged until confirmed dispatch.

## 2026-07-11

- Added Chrome MV3 localization with English as the default locale and Simplified Chinese in `_locales/zh_CN`. Manifest metadata, popup, settings, and injected content UI use `shared/i18n.js` with cached lookups. Validate with `node --test tests/i18n.test.mjs`.
- Added CoomerFans popup Creator Fetch support. Manifest host permissions include coomerfans.com; `API.COOMERFANS_HOST` and `API.COOMERFANS_ORIGIN` are centralized; normalized history identities use `source=coomerfans`.
- Replaced legacy `chrome.storage.local` history blobs with `kdownloaderHistory` IndexedDB version 3. Generation-keyed imports use an active-generation pointer, no secondary indexes, 4 MiB chunks, O(1) commit, pinned paginated exports, and maintained statistics metadata.
- Added `migrate_history_json.py` as an offline-only converter from legacy exports to schemaVersion 2 records.
- Restored the shared non-CoomerFans history namespace with `source=default` for Pawchive, Kemono, and Coomer. Import rejects duplicate identities within or across chunks while preserving the active generation.
- Added `CoomerFans` popup Creator Fetch scope for `https://coomerfans.com/u/{platform}/{creator_id}/{creator_name}`. `API.COOMERFANS_HOST` and `API.COOMERFANS_ORIGIN` are centralized, and normalized records use `source=coomerfans` plus platform, creator, and post identity.
- History export/Gist JSON uses schemaVersion 2 with `source`, `service`, `userId`, `postId`, `status`, `totalCount`, `successCount`, `failedCount`, and `updatedAt`; large imports use 4 MiB begin/chunk/commit messages and paginated generation-pinned exports below Chrome's 64 MiB message limit.

## 2026-07-01 to 2026-07-05

- Refactored background routing into focused handler modules, added `checkDownloadedMany`, and added `content/router.js` for HTMX-aware reinjection.
- Updated Gopeed compatibility to use REST with token headers; the old `gopeedPath` UI was removed.
- Added CoomerFans creator/post content injection and popup Creator Fetch support.
- Moved Creator Fetch to a top-level popup panel and advanced configuration to `settings.html`; added conditional backend fields, Search Cache, Gist controls, clear-history maintenance, and Restore defaults.
- Added automatic light/dark theme switching and settings-style action icons.
- The Favorites flag page retained its dedicated route and the manifest order was updated to load shared helpers, UI, download, router, and page actions deterministically.
- Settings originally added backend, batching, Gopeed, Favorites, Search Cache, and Gist configuration with `options_ui.open_in_tab`; popup visibility for Gist remains controlled by `gistConfig.enabled`.
- Legacy `downloaded`/`coomerfansDownloaded` storage blobs were intentionally replaced by the IndexedDB history design described above; no runtime migration was added.
- Historical cleanup removed empty documentation/debug artifacts and retained `injected/creators_page.js` because it is dynamically injected by `content/injector.js`.
- The former automatic light/dark theme pass and inline SVG icon pass are preserved as history; current shared primitives live in `shared/ui.css`, `shared/ui.js`, and `shared/icons.svg`.
- 2026-07-05: The former Pawchive-equivalent domain entry expanded host permissions and shared-source behavior. This historical behavior is superseded by the current `PAW` contract, which supports only `pawchive.pw` and `file.pawchive.pw`.
- Historical notes about the former favorites watcher, legacy storage blobs, and old Pawchive domains are retained here for context only; current behavior is defined by `AGENTS.md` and the runtime files.
