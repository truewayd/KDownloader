# KDownloader and TrueDown project audit

Date: 2026-09-05. Working branch: `main`. Extension version after fixes: `1.2.3`.

Further source review, additional fixes and refreshed verification are recorded
in `project-reaudit-2026-09-05.md`. The results below describe the earlier audit.

## Scope and method

Reviewed the extension background, IndexedDB history, configuration and secret
migration, message authorization, download/batch lifecycle, content injection,
popup/settings/shared UI, and the TrueDown HTTP boundary, downloader queue,
SQLite persistence, resolvers, engine lifecycle, updater, application logs,
platform integration, and build/release boundaries. Three parallel audits were
followed by independent reviews of the updater and downloader changes.

The initial worktree already contained Unix release workflow, validation tools,
documentation, and ignore-rule changes. They were preserved and their tests were
included. No commit, push, publication, installation, real download, or changes
to the user's running browser profile were performed.

Existing ownership boundaries were retained. Fixes address reproducible behavior
and concurrency failures rather than replacing working subsystems. This is a
source, regression, build, and bounded integration audit; it is not a guarantee
that all possible defects or external service changes have been exhausted.

## Architecture and data structures

| Area | Audited boundary and outcome |
| --- | --- |
| History | IndexedDB v3 generation pointer and metadata; compound history identity; chunked import/export and snapshot revisions. Fixed reserved metadata access through import session IDs. |
| Configuration | Sync preferences and local-only backend/Gist secrets. Serialized writes and migration reads; settings forms cannot mix overlapping save/restore operations. |
| Extension RPC | Sender/host checks, bounded requests, accepted request IDs, and projected responses. Added a terminal batch result after durable history and TXT declaration. |
| Download state | Post/media results remain distinct; incomplete Pawchive content cannot create media/history. Creator fetch failures now surface instead of appearing as empty success. |
| Shared UI | Canonical components and isolated-world hydration retained. Async reads validate the current route/control state; loading and retry states remain coherent. |
| TrueDown queue | Indexed tasks/GIDs, bounded admission, revision-guarded persistence, and redacted task snapshots retained. Resolver network waits no longer hold the operation mutex. |
| BitTorrent | Native output roots and persisted pause intent survive restoration. Metadata-parent completion rebinds to its child rather than completing the whole torrent prematurely. |
| Resolver registry | Immutable module snapshots, compiled host/resource bounds, and persisted request identity retained. Dropbox preparation now propagates lifecycle cancellation. |
| Updater | Verified artifacts and settings use commit-after-persistence semantics. Automatic application observes the user's automatic-update preference. |
| Platform/build | Windows package checks passed. Unix lock files must be regular files, build roots reject symlinks, and smoke binaries use private temporary paths. |

## Findings resolved

All findings below have been implemented. P1 denotes data loss, inconsistent
download lifecycle, credential-state corruption, or prolonged operation blocking;
P2 denotes incorrect behavior, boundary weakness, or avoidable resource cost.

| ID | Priority | Trigger and previous effect | Resolution and regression evidence |
| --- | --- | --- | --- |
| KD-01 | P1 | Import abort with the internal active-generation ID deleted the history pointer. | Reject reserved import-session IDs; DB regression confirms active history survives. |
| KD-02 | P1 | Concurrent partial setting saves lost fields; delayed legacy migration restored a cleared secret. | Shared configuration mutation queue; save/migration/default races tested. |
| KD-03 | P1 | Per-post/media progress could finish a batch before history or TXT work, hiding later failures. | Explicit `downloadComplete` with `batch=true`, request ID, aggregate post counts, and errors after final work; backend/frontend integration regressions. |
| KD-04 | P2 | Invalid creator profiles, failed pagination, or exhausted CoomerFans routes looked like successful partial/empty fetches. | Propagate failures through the accepted request's terminal result. |
| KD-05 | P2 | Creator/page fetch discarded incomplete Pawchive posts before extracting their existing links. | Preserve posts for safe link extraction; media/history restriction remains tested. |
| UI-01 | P2 | Late history/status reads replaced an action's newer loading or completion state. | Validate control and render state before applying post/creator/Favorites lookups. |
| UI-02 | P2 | SPA DOM reuse retained active/disabled controls for the previous post/page identity. | Replace controls when identity changes; isolated-world route tests. |
| UI-03 | P2 | Link-only creator cards and partially failed batches disabled manual retry. | Keep no-file and partial results retryable; require explicit full batch success for permanent completion. |
| UI-04 | P2 | Favorites lookups could exceed the background RPC batch limit. | Chunk lookups within the existing limit. |
| UI-05 | P2 | Returning to a previous TrueDown page sent a cached ETag without its cached body and kept unrelated rows after 304. | Reuse validators only for the currently displayed page body; pagination round-trip regression and Chrome smoke. |
| UI-06 | P2 | Late task fetches overwrote changed search/sort/page state; forced refreshes multiplied requests. | Validate query identity before rendering and coalesce refresh requests. |
| UI-07 | P2 | Polling re-enabled queue/retry buttons during active operations. | Preserve busy state when updating metrics. |
| UI-08 | P2 | Failed file/folder actions rejected without a visible result. | Catch action errors and show a toast; browser smoke exercises the error. |
| UI-09 | P2 | Save/restore/reload overlapped; early Promise rejection reopened forms while other writes were pending. | Gate extension settings operations and TrueDown submits; disable form controls and await every started settings write. |
| TD-01 | P1 | Restored torrent output metadata entered HTTP collision-renaming and `out` handling. | Keep torrent native save roots and omit HTTP output overrides; restore regression. |
| TD-02 | P1 | Reattaching a native torrent GID ignored persisted pause/resume intent. | Reconcile engine state before attaching; active/paused restoration cases. |
| TD-03 | P1 | A completed metadata parent appeared before its child in separately fetched RPC snapshots. | Persist announced child GID and keep admission until child completion. |
| TD-04 | P1 | Dropbox HEAD/GET preparation ignored shutdown and could block for five minutes or persist a spurious failure. | Propagate lifecycle context, stop fallback after cancellation, and preserve queued intent; Stop/reopen regression. |
| TD-05 | P1 | A slow resolver held the task-operation mutex, blocking add/pause/remove. | Release it during preparation, then revalidate identity/GID, admission, current pause state, engine state, and cancellation before submission. Tests hold the resolver open while queue operations complete. |
| SYS-01 | P2 | A staged update auto-restarted even after automatic updates were disabled. | Check the setting again when requesting automatic application; manual restart remains available. |
| SYS-02 | P1 | Failed updater preference or metadata persistence still changed live state. | Persist candidate state before publication; failure regressions preserve the previous setting, engine preference, and error. |
| SYS-03 | P2 | Write Origin validation compared the host but accepted a different scheme or malformed origin components. | Require matching HTTP/TLS scheme and host, and reject credentials/path/query components; boundary tests. |
| SYS-04 | P2 | Malformed UTF-8 in long logs caused repeated prefix scans and discarded later diagnostics; repaired tails could exceed their byte limit. | Inspect only the split-rune boundary and re-bound repaired tails; malformed-log regressions. |
| SYS-05 | P2 | Unix instance acquisition accepted a nonregular lock path. | Nonblocking, non-following open plus regular-file check; FIFO/symlink regressions. |
| SYS-06 | P2 | Symlinked Unix `dist` escaped the output boundary; smoke tests shared a predictable executable path. | Reject the symlinked root and use a private temporary executable; Unix build-safety fixture passes. |

## Performance evidence

Existing downloader benchmarks were run against the final implementation on
Windows amd64 using 10,000 tasks. These are final-state measurements, not a
before/after speedup claim; timings vary with the host and concurrent work.

| Operation | Time per operation | Allocation |
| --- | ---: | ---: |
| Default page, 100 rows | 84.1 microseconds | 18,472 bytes; 3 allocations |
| Status-sorted page, 100 rows | 42.9 microseconds | 18,500 bytes; 5 allocations |
| Filename/link search page | 2.39 milliseconds | 18,557 bytes; 6 allocations |
| Unchanged conditional page | 340 nanoseconds | 32 bytes; 2 allocations |

The main fixes to responsiveness are removing resolver network waits from the
operation lock, coalescing task refreshes, preserving valid conditional-page
reuse, and removing repeated full-prefix UTF-8 scans.

## Initial full audit verification

| Check | Result |
| --- | --- |
| Node full suite | 237/237 pass; baseline was 213/213. |
| Python history migration | 13/13 pass. |
| Python release-asset validator | 8/8 pass, including the existing Unix release work. |
| Go full suite | All six packages pass with the final downloader changes. |
| Go static analysis | `go vet ./...` passes. |
| Shared UI mirror | `npm run ui:check` passes; shared component runtime unchanged. |
| Extension version/build | Version 1.2.2 validates; clean extension build passes. |
| Windows package | `build.ps1 -OutputDirectory dist/TrueDown-audit` passes, including PE/resources/DPI checks. |
| Windows aria2 integration | Native lifecycle, unexpected engine exit/recovery, and manager hot-reload tests pass with `TRUEDOWN_INTEGRATION=1`. |
| Linux test build | All test binaries and service cross-compile successfully. |
| Linux full tests/integration | All six package test binaries pass in Ubuntu WSL, including native aria2 lifecycle/recovery, in-process engine reload, and FIFO/symlink lock checks. |
| Linux lifecycle smoke | PASS: ping, SQLite/tasks, single instance (28 ms), dashboard exit, aria2 child reaped. |
| Unix build safety | Symlinked dist and package outputs rejected; external sentinel preserved. |
| Chrome 152 dashboard | Mock API smoke passes pagination 0 -> 100 -> 0, search, action errors, settings save, and no uncaught page errors. |
| Responsive/color checks | TrueDown at 1280/390 widths in both light/dark passes settings save and overflow checks. |
| Chrome isolated-world controls | Shadow hydration, history/live-state race, route identity replacement, and filtered/deduplicated external-link dialog pass. |
| Independent final review | Downloader concurrency and updater/auth/log/platform changes reviewed separately; no new actionable findings. |

Node's isolated test workers required an approved run outside the sandbox.
Go compilation used a workspace-local cache where the global cache was denied.
Python tests used the bundled interpreter. WSL tests use the installed Ubuntu
aria2 and isolated temporary data. Test logs are retained under
`truedown/dist/audit-logs/` after cleanup of working-directory temporary logs.

## UI consistency follow-up

The follow-up compared the extension popup, settings, injected controls and
TrueDown dashboard against their shared component contract, backend settings
limits and asynchronous operation state. Parallel reviews covered extension
pages, shared primitives and Chrome browser fixtures. Every confirmed issue in
this follow-up was fixed.

| Area | Previous inconsistency | Implemented result |
| --- | --- | --- |
| Popup | Expanded panels placed History actions below the unscrollable popup boundary; the title named only Kemono. | Preserve the 360px width, constrain height and scroll the content region; use KDownloader branding in both locales. |
| Controls and themes | Selects, focus rings, disabled hover feedback and light-theme text differed; a long toggle label squeezed its checkbox. | Align shared and dashboard control tokens, preserve select arrows across states, improve contrast and prevent checkbox shrinkage. |
| Busy feedback | Icons, checkboxes and injected host boxes could expose conflicting disabled/busy cursors or accessible state. | Canonical busy helpers manage attributes and temporary labels; host and inner button progress cursors agree. |
| Settings persistence | Blank numeric inputs became zero; normalized backend values were not reflected; completion feedback disappeared immediately. | Use declared defaults for blank values, render saved normalized settings and retain success/error feedback. |
| Confirmation | Extension settings used browser confirms; keyboard focus could escape or restore to an inert trigger. | Shared localized native dialog with explicit Tab containment, Escape/backdrop cancellation and focus restoration. TrueDown retains scroll locking beneath nested dialogs and restores focus after settings unlock. |
| Task creation | Repeated submissions were possible; a delayed close could dismiss a later modal; an explicit zero speed inherited the default. | Guard and lock submissions, close immediately after successful dispatch, show a toast, and honor zero as unlimited. |
| Backend form contract | Connection and retry bounds differed between the task form, settings and backend. | Align connections to 1–64, retry count to 1–100, retry wait to 1–3600 and queue IDs to 0–1,000,000. |
| Refresh and accessibility | Failed refreshes announced success; immediate modal Tab navigation and dynamic icons had inconsistent semantics. | Announce refresh success only after a successful fetch; contain focus immediately, including inert forms, and mark dynamic icons decorative. |

The shared runtime was regenerated byte-for-byte into TrueDown. Component
ownership and confirmation behavior are documented in `docs/ui-architecture.md`.
Product release notes include both this follow-up and the preceding audit.

| Final follow-up check | Result |
| --- | --- |
| Node full suite | 252/252 pass, including 15 additional UI regressions since the initial audit. |
| Shared UI mirror and version | `npm run ui:check` and `npm run version:check` pass; version 1.2.3. |
| Extension build | `npm run build` produces the clean unpacked extension. |
| TrueDown tests and static analysis | All six Go packages pass; `go vet ./...` passes with the final UI sources. |
| TrueDown Windows build | `build.ps1 -OutputDirectory dist/TrueDown-audit` passes, including PE/resources/DPI checks. |
| Browser behavior | Chrome 152 source-backed fixtures pass 14 grouped behavior checks plus busy-form Tab/Shift+Tab checks at 390px and 1280px. |
| Browser layout/theme | English/Chinese popup at 360×600 and settings/dashboard at 390px/1280px in light/dark; no uncaught errors, missing labels or uncontained horizontal overflow. |
| Popup reachability | All panels plus active progress scroll correctly; History export is visible at y=539.8–575.8 after scrolling instead of being clipped at y=615.8–651.8. |

Browser screenshots and machine-readable fixture results are retained in the
session visualization directory. The full Node output is
`truedown/dist/audit-logs/ui-npm-test.log`. The earlier Python, native aria2 and
Linux lifecycle checks remain the verification for unchanged non-UI code.

## Limits and remaining platform validation

- Chrome tests used mock APIs and an isolated profile. The real extension action
  popup and authenticated live Kemono/Pawchive/CoomerFans pages were not manually
  exercised, and no real remote download was submitted. The follow-up popup layout
  was exercised through source-backed fixtures: the installed Chrome build does
  not expose unpacked-extension loading through its automation flags or CDP, so
  the actual Chrome action popup remains a manual validation item.
- Official Aria2 Next BitTorrent network behavior was checked with deterministic
  RPC/lifecycle fixtures; live torrent downloading was not used as a test.
- macOS native execution, notarization, and release archive publication were not
  performed on this Windows host. Existing platform CI remains responsible for
  all native release architectures and the complete asset set.
- Go's race detector was not run: this Windows Go environment lacks a CGo C
  compiler and WSL lacks a native Go toolchain. Deterministic concurrency tests,
  full tests, static analysis, and independent lock/lifecycle review were used.

No confirmed finding above remains intentionally unfixed. The validation limits
are external coverage limits, not claims that those environments are verified.
