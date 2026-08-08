# KDownloader Agent Guide

Last reviewed: 2026-08-02

This file is the current engineering contract for the extension. Historical release notes live in `changelog/`; do not append dated entries here.

## Project Shape

This repository is a monorepo containing KDownloader and TrueDown. KDownloader is a dependency-free Chrome Manifest V3 extension. Runtime code is plain JavaScript and CSS; background code uses ES modules and the content/page scripts are load-order-sensitive classic scripts.

```text
background/             MV3 service-worker modules and RPC handlers
content/                site actions, shared content helpers/UI, route watcher
shared/                 i18n, extension-page UI primitives, external icon sprite
popup/                  minimal daily-use popup and search helper
settings.html/.css/.js  advanced options page
injected/               page-context creator-cache bridge
icons/                  extension icons
tests/                  Node test runner and Python migration tests
tools/                  clean build and changelog selection scripts
changelog/              dated release notes and historical archive
manifest.json           permissions and content-script order
truedown/               TrueDown Go application, embedded web UI, tests, and build script
```

Do not edit `dist/` by hand. It is generated and ignored.

## Background Contracts

- `background/constants.js` is the only source for `CONFIG`, storage keys, `API`, and `PAW`.
- `API.HOSTS` contains only hosts that use the shared `/api/v1` and creator override flows. `API.COOMERFANS_ORIGIN` is separate. `PAW` is fixed to `pawchive.pw` and `file.pawchive.pw`; do not reintroduce old Pawchive domains.
- `background/messages.js` builds the RPC table from `background/handlers/*.js`. Long operations acknowledge synchronously with `{ accepted: true }`, then broadcast progress and a terminal completion message.
- `background/network.js` owns fetch, cookies, Pawchive bridge routing, Cloudflare/WAF detection, and challenge notifications. Pawchive JSON requests go through `fetchPawchiveJson`.
- `background/db.js` owns IndexedDB history version 3. The active generation pointer and generation metadata make import commit and stats O(1). Records use compound identity `[source, service, userId, postId]`; supported statuses are `partial`, `complete`, and `empty`.
- History is not copied through a single runtime message. Use `db.import.begin/chunk/commit/abort` and `db.export.begin/page` with bounded payloads. Duplicate identities must abort an import without changing the active generation.
- `background/download.js` owns task construction, suffix filtering, batching, bounded workers, retries, progress, backend dispatch, and link TXT declaration. Native Chrome fallback is only offered after the persisted, user-confirmed total-failure notification.
- `background/config.js` owns backend, download-rule, Watch, and Gist defaults/normalization. `settings.restoreDefaults` resets those values in one sync write, disables the creators override, and reschedules the Watch alarm; it never clears history or the Watch list.
- `background/creators.js` owns the Kemono/Coomer creator cache and enable flag. `background/watch.js` owns Pawchive Watch only.
- Remove exports only after `rg`/`git grep` confirms there are no runtime, test, or build references.

## Content Script Order

Keep `manifest.json` injection order stable. The current order is:

1. Pawchive document-start API bridge: `content/paw_api_bridge.js`.
2. Kemono/Coomer document-start page injector: `content/injector.js`.
3. Site UI scripts: `content/helpers.js`, `shared/i18n.js`, `content/ui.js`, `content/download.js`, `content/router.js`, then the site action script.
4. Favorites pages: `helpers -> i18n -> ui -> router -> flag/index.js`, plus `content.css`.

The site action scripts are `actions.js`, `paw_actions.js`, and `coomerfans_actions.js`. They discover site-specific DOM data and request payloads; shared creation, state, modal, and progress behavior belongs in `content/ui.js` or `content/download.js`.

- Register idempotent renderers with `KDRouteWatcher`. Do not patch history or create a second bootstrap scheduler.
- Use `safeSendMessage`, batch status checks with `checkDownloadedMany`, and guard async renders with `isRenderCurrent`.
- Kemono, Pawchive, and CoomerFans creator cards use real `button` elements, `data-batch-download="true"`, `data-path`, and the shared `kd-creator-button` component. Do not nest a legacy site button class or inline positioning styles.
- Pawchive Watch is available only on creator pages. Its state is read and changed through `watch.*` RPCs.
- CoomerFans identities use `source=coomerfans`; all other supported sites retain `source=default`.
- The document-start bridge accepts only same-origin Pawchive `/api/v1/` GETs. Never pass Cloudflare clearance cookies, browser identity headers, arbitrary methods, or arbitrary origins through messages.

## Shared UI Rules

- `shared/ui.css` is the single source for extension-page tokens, controls, panels, focus rings, notifications, loading indicators, segmented controls, and reduced-motion behavior.
- `shared/ui.js` is the single source for extension-page message sending, busy-button state, toast lifecycle, icon-button updates, and segmented state. Popup and settings must not reimplement these helpers.
- `shared/icons.svg` is the only extension-page icon sprite. Use external `<use href=".../shared/icons.svg#icon-name">`; do not duplicate inline symbol blocks.
- Use the `kd-*` component vocabulary (`kd-panel`, `kd-button`, `kd-icon-button`, `kd-input`, `kd-select`, `kd-hidden`, etc.). Page CSS should define layout only.
- The Chrome action popup width is explicitly owned by `popup/popup.css`. Preserve the configured project value unless the user requests a width change; verify the real extension popup after changing it.
- Settings uses the same primitives and a normal-flow sticky action bar; controls must not cover other content.
- `content.css` is host-safe and scoped to `kd-*`. Keyframes must be uniquely prefixed; never use generic `spin`/`fadeIn` names or `transition: all`.
- Use explicit motion durations and honor `prefers-reduced-motion`. Keep cards and modal corners at 8px or less. Do not introduce decorative blobs, gradients, or one-note color palettes.
- Every interactive icon needs an accessible label/title; decorative SVGs must be `aria-hidden` and unfocusable. Dynamic status buttons must update `aria-busy`, `aria-disabled`, and `aria-label` where applicable.
- External-link modals must deduplicate and accept only HTTP(S) URLs, expose dialog semantics, close on Escape/backdrop, trap focus, and restore focus.
- Keep host-page positioning changes class-based (`kd-position-context`), not inline `style` assignments.

## Popup And Settings Behavior

- Popup defaults to Pawchive Site Search and supports Pawchive, Kemono, Coomer, and CoomerFans URL shapes from `popup/search.js`.
- Creator Fetch exposes non-persistent `default`, `full`, `links`, and Pawchive-only `dms` modes. Links and DMs modes may run without a media backend and declare their TXT directly through `chrome.downloads`; DMs scrape only the creator's fixed Pawchive `/dms` HTML page and export published dates, text, and links without history writes.
- Popup shows Creator Fetch and History by default; Search Cache and Gist panels are visibility-controlled by their settings. Destructive history maintenance remains in settings.
- Popup global progress is hidden when `total <= 0` and visible only for active work.
- Settings uses RPCs for every persisted setting. Do not write `chrome.storage` directly from page scripts. Restore defaults preserves IndexedDB history and `pawchiveWatches`.

## Storage And Configuration

Current durable keys are `backendConfig`, `downloadRulesConfig`, `watchConfig`, `gistConfig`, `creatorsOverrideEnabled`, `pawchiveWatches`, `pawchiveWatchIcons`, and lightweight progress/revision signals. Download history is IndexedDB; pending native fallback tasks use session storage.

Download rules are stored in sync storage as `{ enabled, excludedExtensions }`. Values are lowercase dot-prefixed suffixes and matching is case-insensitive against normalized filenames, then URL paths. The default selectable list is `.psd`, `.clip`, `.sai`, `.sai2`, `.kra`, `.xcf`, `.procreate`, `.afphoto`, `.afdesign`, `.blend`.

Pawchive Watch stores `{ schemaVersion: 1, watches }` in local storage and keeps avatar data outside exports. A manual add establishes the current profile update baseline before notifications are enabled. Scheduled checks aggregate updates/failures and preserve baselines on failure.

## Build And Release

- `tools/build-extension.ps1` creates a clean unpacked directory (normally `dist/KDownloader`) containing runtime files only. It rejects Python artifacts and underscore-prefixed reserved paths other than `_locales`.
- `package.json` is developer-only metadata (`npm test`, `npm run test:python`, and `npm run build`) and is not copied into the extension build.
- Release notes are required in `changelog/YYYY-MM-DD-NNN-short-slug.md`. Increment the zero-padded daily sequence; `tools/read-latest-changelog.ps1` selects the newest dated file and writes `release-notes.md`.
- `.github/workflows/publish-extension.yml` builds, archives, uploads, and publishes a release whose body is read from that latest changelog file. Keep the filename date prefix sortable and do not rely on GitHub-generated notes for project changes.
- KDownloader and TrueDown releases are path-scoped. KDownloader changes publish through `publish-extension.yml`; `truedown/**` changes publish through `publish-truedown.yml`. A commit that changes both products publishes both releases.
- `truedown/build.ps1` creates the TrueDown Windows package with `TrueDown.exe` and `aria2c.exe`. TrueDown tags use the `truedown-build-*` prefix so they cannot collide with KDownloader tags.

## Verification

Run the focused test first, then the full suite:

```text
npm test
python -m unittest tests/migrate_history_json_test.py
pwsh -NoProfile -ExecutionPolicy Bypass -File tools/build-extension.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File tools/read-latest-changelog.ps1 -OutputFile release-notes.md
```

When UI or content code changes, also verify:

- the real Chrome action popup in both color schemes, preserving the configured width;
- settings at desktop and mobile widths with no horizontal overflow or action-bar overlap;
- Kemono, Pawchive, CoomerFans, and Favorites reinjection after history navigation/HTMX swaps;
- keyboard focus, reduced motion, loading/progress, success/error/reset states, modal focus trapping, and duplicate-render idempotency;
- backend slow/failure paths, native fallback confirmation/cancellation, and absence of premature history writes.

## Editing Rules

- Prefer async/await, structured parsers, centralized network/download/DB boundaries, and small focused modules.
- Use `apply_patch` for manual edits. Keep comments short and explain only non-obvious logic.
- Preserve unrelated user changes in a dirty worktree. Never reset or checkout files to discard work you did not make.
- Keep new files ASCII unless the existing file format requires another charset.
- Update `manifest.json`, this guide's current contract, tests, and a dated `changelog/` file whenever a change affects runtime APIs, injection order, permissions, storage, or release behavior.
