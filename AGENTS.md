AGENTS.md

Purpose
-------
This document explains the repository layout, conventions, and how agents/developers should collaborate on this extension project. It contains concrete rules and step-by-step guidance for splitting content scripts, implementing batch downloads, minimizing storage writes, and integrating third-party downloaders safely.

Repository structure (current)
------------------------------
- background/ - MV3 service worker modules
  - index.js (entry)
  - constants.js (CONFIG, storage keys, alarm names)
  - util.js (sanitizeFileName, getFileExtension, extractExternalLinks, buildDownloadTasks)
  - db.js (history DB and lastAccess helpers)
  - config.js (favorites/backend/gist config helpers)
  - network.js (fetch API, cookies)
  - download.js (startFullDownload, runSequentialDownloads, backend batching)
  - messages.js (message router / RPC handlers)
- content/ - content script modules (helpers.js, ui.js, download.js, actions.js)
- content.css - styles for UI elements injected into pages
- popup/ - popup UI and scripts
- icons/ - icon assets
- manifest.json - extension manifest (must list content scripts in injection order)

High-level goals for agents
---------------------------
- Keep content scripts small, predictable, and load-order safe.
- Minimize chrome.storage writes: batch changes and use flush-on-idle or thresholds.
- For posts with many files, avoid overwhelming backend or external downloaders by chunking files and throttling/concurrency limits.
- Provide robust messaging (ack, progress, complete) and timeouts/heartbeat to avoid false timeouts.

Centralize API base & paths
---------------------------
To avoid scattering hard-coded origins and API paths across the codebase, keep a single source-of-truth for API hosts and path prefixes in background/constants.js as an exported API object. Use this canonical API object in background modules. Example fields:
- API.HOSTS: array of known hostnames (['coomer.st','kemono.cr'])
- API.DEFAULT_ORIGIN: default origin (e.g. 'https://kemono.cr')
- API.API_PREFIX: common API prefix (e.g. '/api/v1')
- API.CREATORS_PATH: creators endpoint suffix ('/creators')

Guidelines:
- Background modules should import { API } from './constants.js' and build API URLs using API.API_PREFIX and API.CREATORS_PATH instead of hard-coded strings.
- Content/injected page scripts cannot import extension modules. For injected scripts that run in page context, declare small local constants (e.g. API_PREFIX = '/api/v1' and CREATORS_PATH = '/creators') and use them when intercepting or responding to site requests.
- When adding or renaming API endpoints, update background/constants.js only; background modules will pick up changes when reloaded. Also scan for tests or injected scripts that contain local duplicates and update accordingly.
- Avoid embedding full origin strings (https://coomer.st) in many places. Use API.HOSTS and API.DEFAULT_ORIGIN when detection logic is necessary (e.g., use senderUrl hostname to choose which host's origin to use).

Rationale:
- Centralization makes it trivial to migrate to a new API host or adjust path prefixes without hunting through multiple files.
- Keeps injected page script stable (local constants) while letting background logic be authoritative.

Splitting content scripts (how-to)
----------------------------------
1. Identify logical areas and place them under content/:
   - helpers.js : safeSendMessage, parseUrlPath, isPostDownloaded, reportAccessIfApplicable
   - ui.js : BTN_STATUS, updateButtonStatus, showExternalLinksModal, removeOldButtons
   - download.js : handleDownload (single post), per-post watchdogs, progress handling
   - actions.js : DOM interaction (add buttons), Page Fetch batch logic, SPA observer
2. Injection order in manifest.json matters: helpers -> ui -> download -> actions. Later scripts assume globals defined by earlier ones.
3. When adding content/*.js, update manifest.json accordingly.
4. Keep content.js removed (no bootstrap file needed). Test by reloading the extension and ensure no ReferenceError.

Message patterns and timeouts
-----------------------------
- Always call background with safeSendMessage which:
  - retries transient errors (service worker cold start, 'message port closed').
  - uses a configurable timeout and retryDelay.
- Background responses for long work:
  1) Immediately reply ack { accepted: true } synchronously to avoid content-side timeout.
  2) Send periodic progress messages: { action: 'downloadProgress', service, userId, postId, sentCount, totalCount, progress }
  3) Send final completion: { action: 'downloadComplete', service, userId, postId, result }
- Content scripts should implement a watchdog: reset on progress messages; only consider a true timeout when no progress has been received within a generous window (e.g., per-file estimate × file count or a configured max like 10 minutes by default).

Batching & DB write policy
--------------------------
- Do not write individual post records to chrome.storage.sync/local for every single file or very frequently. Use one of the following:
  - markMultipleDownloaded(items) on batch completion (backend or startDownloadBatch) — single write for many items.
  - Client-side in-memory buffer (DownloadDB proxy) that collects markDownloaded calls and flushes every N seconds or when it reaches a threshold.
- Background provides markDownloaded and markMultipleDownloaded RPCs; prefer markMultipleDownloaded for groups.
- When safeIncrementStorageVersion fails due to sync quotas, schedule a retry using chrome.alarms (SYNC_VERSION_ALARM).

Handling third-party/back-end downloaders safely
-----------------------------------------------
- Per-post file limit: split files into batches (perPostFileLimit, default 100).
- Concurrency throttling: bounded worker pool (1–6; default 3) per batch. These values are configurable via the popup backend settings (concurrency and per-post batch size).
- Spacing: small pause between files (~500ms) and between batches (~1s).
- Per-file retry with backoff; aggregate per-file results.
- Progress reporting after each dispatch to keep UI watchdog alive.
- Fallback to local downloads (chrome.downloads) if backend dispatch fails.

How to implement batching in background (recommended pattern)
-----------------------------------------------------------
- Build the file task list from post data (UTIL.buildDownloadTasks).
- If backend enabled:
  - Split tasks into batches of size perPostFileLimit.
  - For each batch, run a worker pool of size concurrency that consumes the batch array using an atomic index.
  - After each file dispatch, increment a global counter and send a progress message.
  - Between batches, wait a small pause (1s) to avoid bursts.
  - Aggregate file dispatch results and return them to caller.
- After a successful post (some files dispatched), use markDownloaded or let caller decide when to mark. For batch operations across posts, collect successful posts and call markMultipleDownloaded once at the end.

Testing & validation checklist
------------------------------
- Unit test util functions when possible (sanitizeFileName, getFileExtension, buildDownloadTasks).
- Manual integration tests:
  - Reload extension, open a post with few files — click single-post download — expect progress and completion.
  - Open a creator page with many posts — click Page Fetch — expect batch progress, per-post ack, and eventual DB updates (batched writes).
  - Creators override:
    - Popup → Update coomer.st / kemono.cr — background logs fetch ok and write meta; popup显示更新时间。
    - 页面 Console 执行 window.__EXT_CREATORS.readCache(location.hostname).then(console.log) 能拿到 { host, updatedAt, data }。
    - Network 中 /api/v1/creators 请求被拦截时返回本地 JSON（若页面会发该请求）。
  - Simulate slow backend: add artificial delays and ensure content's watchdog doesn't fire incorrectly (progress messages must be sent periodically).
  - Simulate backend failures and ensure fallback to local downloads works, and DB writes only for successfully dispatched posts.

Commits and PR guidance
-----------------------
- Keep changes minimal and focused: modify only the files necessary for a feature/fix.
- Include tests or manual test steps in PR description.
- Document configuration keys added to storage (e.g., backend.config fields) in AGENTS.md.

Conventions for agents
----------------------
- Use async/await and handle errors.
- Prefer background-level centralization for cookie access, downloads, and DB writes.
- Avoid heavy DOM operations in content scripts; use simple selectors and attach listeners.
- Update manifest.json when adding content scripts; ensure injection order is correct.
- Prefer module-based design over attaching functions to window. Content scripts rely on injection order to share globals; avoid window pollution unless absolutely necessary for third-party interop.

Cleanup & dead code
-------------------
- Remove unused imports: if a file imports a symbol but does not use it, remove the import to avoid ambiguity and bundling overhead.
- Do not leave duplicate imports inside files. All imports should be at the top of the module.
- Remove or archive truly unused files (scripts that are no longer referenced by manifest.json or other modules). Before deleting, search for references across the repo and update AGENTS.md changelog.
- Run a linter (ESLint) and unit tests where available before opening PRs. Prefer small, focused commits for clean history.

Contact
-------
- Add notes in PRs explaining any backward-incompatible changes (especially message shapes).
