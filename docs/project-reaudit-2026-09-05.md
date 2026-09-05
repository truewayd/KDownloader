# KDownloader and TrueDown follow-up project audit

Date: 2026-09-05. Extension version: 1.2.4.

## Scope and baseline

This review starts from the uncommitted implementation documented in
`project-audit-2026-09-05.md`, including the earlier Unix release and UI work.
Those changes were preserved. The current baseline passed 252 Node tests,
13 Python history-migration tests and 8 Python release-validator tests.

Parallel source audits covered the extension backend/cache bridge, all frontend
surfaces, and the TrueDown backend. The integration review also covered native
Windows interop, Unix startup/builds, release workflows, SQLite adapters, data
ownership, hot-path allocations and existing architecture contracts. Downloader
concurrency changes received an independent second review.

## Additional confirmed findings and fixes

| Area | Trigger and effect | Fix |
| --- | --- | --- |
| Creator Fetch | Popup Coomer fetch used the extension-page sender origin for individual posts, falling back to Kemono. | Carry the validated creator origin through post downloads. |
| Configuration effects | Slow older TrueDown sync or alarm clear/create completed after a newer save. | Serialize each external side-effect queue, await completion and recover after failure. |
| Creator cache | Reused XHR or reentrant event handlers received stale cache responses. | Validate request identity before dispatch and after each synchronous event. |
| Cache lifecycle | A pending IndexedDB open survived page cleanup and replaced a newer connection; bfcache restored an obsolete override state. | Invalidate opens by sequence and resynchronize page state on restoration. |
| Content requests | Page cleanup retained sending controls or late acknowledgements reactivated detached requests. | Reset pending controls and reject obsolete acknowledgements. |
| History UI | Import notifications omitted Pawchive/Favorites; large lookups exceeded RPC limits. | Route shared refresh notifications to all sites and chunk lookups. |
| Engine results | Global completed-result purging deleted results not yet observed by TrueDown. | Clear only local/durable completed history; bounded engine eviction reclaims results without per-history RPCs. |
| Engine memory/polling | Historical failed results remained unbounded and the oldest 256 hid later completions. | Bound retention at 512, including failures, and read the newest result window. |
| Pause/resume | An earlier RPC snapshot arrived after a local operation and overwrote its durable intent. | Apply statuses only when the task has not advanced beyond the poll's initial revision. |
| Engine recovery | Engine exit or cancellation during admission changed recoverable queued tasks into errors. | Recheck lifecycle state at admission boundaries and preserve intent. |
| Dashboard settings | Repeated settings opens raced; partial saves left local state inconsistent with successful server writes. | Coalesce opens, await all reads/writes and retain confirmed persisted state. |
| Dashboard rows | Polling discarded focus and pending-operation state; failed removal still cleared selection. | Track operations by task ID, restore equivalent focus and preserve selection on failure. |
| Mobile modals | The mobile max-height override let long forms overflow a clipped viewport; real wheel input could not reach the footer, while automated locator scrolling hid the defect. | Bound modal/form height to 100dvh, preserve header/footer sizing and scroll only the flex body. |
| SQLite allocations | Unix row scans allocated a new pointer array for every row. | Allocate bindings once per query and release retained values on close. |
| Native GC | Tray menu labels were converted to uintptr before the native call, losing pointer lifetime guarantees. | Keep typed pointers until conversion in the syscall argument. |
| Native UI host | Native Custom Element busy controls showed a disabled host cursor despite a progress cursor inside Shadow DOM. | Reflect aria-busy onto the verified host and regenerate the shared mirror. |
| Build metadata | Unix builds accepted inconsistent or overflowing version/build metadata. | Validate canonical bounded build numbers and matching release versions before output work; run guards in native CI. |

The native-pointer fix follows the supported conversion pattern in the
[Go unsafe.Pointer documentation](https://pkg.go.dev/unsafe#Pointer).
The result-window design follows the documented ordering of
[aria2.tellStopped](https://aria2.github.io/manual/en/html/aria2c.html#aria2.tellStopped).

## Architecture and performance

The audit retains the existing ownership boundaries: generation-based IndexedDB
history, serialized configuration writes, centralized network/download handling,
one content route watcher, a canonical shared UI runtime, immutable resolver
snapshots, indexed task/GID state, bounded admission and revision-guarded SQLite
persistence. No framework, runtime dependency or storage-schema migration was
introduced.

The stopped-result window covers two terminal results per admitted task for up
to 256 tasks, including BitTorrent metadata parents and children. The native
engine owns bounded result eviction; the dashboard retains durable history.
Resolver preparation remains serial in the dispatcher but releases the operation
mutex and honors cancellation. Its throughput remains a design limit rather than
an unverified claim of parallel resolver execution.

## Verification results

The final Node suite passes 274/274 tests (22 added since this review's baseline).
Shared component equality, version 1.2.4 validation and the clean extension build
pass. Frontend tests include 70 focused cases and Chrome 152 fixtures for eight
dashboard/popup layout-theme combinations, plus existing pagination, search,
failure, modal and isolated-world control checks. No uncaught page errors were
observed in those fixtures.

Screenshot review prompted an additional real-input check: a full-page image
contained a fixed-overlay capture artifact, but wheel testing also exposed an
actual mobile scrolling defect. After its fix, 18 viewport cases pass across
settings, single and batch download forms; 390x600, 390x900 and 1280x900 layouts;
and light/dark themes. Tests use mouse wheel input, keyboard focus and coordinate
clicks instead of relying on automatic locator scrolling. Header/footer controls
remain reachable while the body scrolls. Corrected viewport screenshots and
`modal-scroll-results.json` are retained with the browser artifacts.

| Final check | Result |
| --- | --- |
| Node full suite | 274/274 pass. |
| Python history migration | 13/13 pass. |
| Python release validator | 8/8 pass. |
| Windows Go tests with native aria2 | All six packages pass with TRUEDOWN_INTEGRATION=1. |
| Windows static analysis | go vet passes for all packages. |
| Extension build/version | Clean unpacked build passes at 1.2.4. |
| Canonical component mirror | Byte-for-byte check passes after native-host busy fix. |
| Windows package | TrueDown-audit build passes, including GUI subsystem, icon and DPI checks. |
| Linux tests | All six final cross-compiled package test binaries pass under WSL, including native aria2 integration. |
| Linux race detector | All six packages pass with Go 1.26.4, CGo and native aria2 integration; final runtime/test snapshot comparison passes. |
| Linux lifecycle smoke | Ping, SQLite/tasks, single instance (86 ms), dashboard exit and aria2 child reaping pass. |
| Unix build safety | Symlink output and invalid release metadata fixtures pass. |
| Release notes selection | Each product resolves its new dated note. |

The Unix SQLite benchmark reads 10,000 rows and three columns. Three runs before
the change allocated 798,610-798,851 bytes and 39,761 objects per iteration;
afterwards they allocated 318,684-318,810 bytes and 29,762 objects. This removes
9,999 allocations and about 480 kB per scan (roughly 60% fewer allocated bytes).
Elapsed ranges were 15.4-21.3 ms before and 15.2-18.5 ms afterwards; concurrent host
load means these timings are not a reliable speedup comparison.

The existing 10,000-task Windows benchmarks retained bounded allocation: default
100-row pages use 3 allocations / 18,465 bytes, status sorting uses 5 / 18,497,
search uses 6 / 18,509, and unchanged conditional pages use 2 / 32. Observed times
were 231 microseconds, 284 microseconds, 11.1 milliseconds and 1.46 microseconds
respectively under concurrent audit load. These are final-state measurements,
not comparative speedup claims.

Machine-readable browser results and screenshots are retained in this task's
visualization directory as `ui-followup-results.json` and the accompanying
fixtures. Full test/build and benchmark logs are in `truedown/dist/audit-logs/`
with the `reaudit-` prefix.

Race testing used the official Linux Go toolchain module verified through the Go
module checksum mechanism. Sources and cached dependencies were copied into an
isolated native filesystem workspace so generated Windows build-cache contents
did not inflate recursive package discovery. The final downloader, SQLite and UI
runtime files were compared back to the working tree after the run.

## Coverage limits

Browser validation uses isolated profiles and controlled APIs. The actual Chrome
action popup and a complete browser-driven bfcache round trip were not exercised.
Authenticated live
site behavior, real remote downloads, live Aria2 Next torrent swarms, native macOS
execution and release publication require their corresponding environments.
No production downloads, installed-browser profile changes, commits, pushes or
releases were performed. These limits do not imply those environments were tested.

All confirmed findings in this review have been fixed. Remaining items above are
validation coverage limits, not unresolved confirmed source defects.

## Pre-commit review, 2026-09-06

Reviewed the final workspace diff by release tooling, TrueDown backend,
extension lifecycle, and shared/frontend UI responsibilities. No additional
blocking source defect was confirmed; the existing fixes and regression tests
were retained for grouped local commits.

Fresh verification passed: 274 Node tests with standard process isolation;
13 Python migration tests and 8 release-validator tests under WSL; all six Go
packages on Windows with native aria2 integration; Windows `go vet ./...`;
freshly cross-compiled Linux tests for all six packages, including native aria2;
Linux lifecycle smoke (single-instance response 12 ms, clean dashboard exit and
aria2 child reaping); Unix symlink/build-metadata guards; canonical UI mirror;
extension build/version 1.2.4; both product changelog selectors; and diff whitespace
validation. A nonisolated Node run was discarded because tests share globals.

This pass did not rerun browser visual fixtures, the real Chrome action popup,
live supported sites, race-detector tests, or native macOS execution. Earlier
browser and race results above remain historical evidence, not new runs.
Commits are local only; no push or release publication is part of this review.
