# KDownloader and TrueDown audit - 2026-09-12

This audit started from clean commit `b2aaa01`. It combines parallel source
review, reproduced failure cases, targeted repairs, independent review of the
resulting diffs, and integrated Windows/Linux/browser verification. Ten concrete
findings are repaired. The shared product version advances from 1.6.4 to 1.6.5.
No push, release publication, or live Gist account mutation was performed.

## Findings and repairs

| ID | Category | Trigger and effect | Repair and evidence |
| --- | --- | --- | --- |
| A01 | Data safety | Two tasks named `file.bin` and `file.bin.aria2` could reserve overlapping payload/control paths before either existed. Recovery or cleanup of one could touch the other's data. | Treat payload and control-file ownership as a pair in allocation, admission, and deletion. Tests cover both name orders, single/batch additions, and preservation of both files for conflicting legacy records. |
| A02 | Data identity | Relative and absolute directory names could create different reservation keys for the same output location. | Normalize reservation directories to absolute paths. Regression adds both spellings and verifies the second output gets a collision suffix. No request fingerprint, durable schema, or file location changes. |
| A03 | Input security | A decoded `/auth/settings` object with missing or null `enabled` used Go's false zero value and could disable authentication. | Require an explicit boolean before calling the auth provider. Invalid fields return 400 without state or session-cookie changes, including externally managed auth. This is an invalid authenticated mutation, not a demonstrated unauthenticated bypass. |
| A04 | Extension data | Legal 512-character creator identities containing quotes/backslashes could produce a 2055-character tuple key, exceeding the old 2048-character read limit. A later save silently dropped it. | Derive the key bound from the accepted identity lengths and JSON encoding. Regression verifies another creator's save preserves the escaped identity. Existing total count/byte bounds remain. |
| A05 | Page lifecycle | A pending intercepted fetch/XHR could fall back to the network or deliver cached data after pagehide, including after bfcache restored the override. | Use a separate page lifecycle generation to invalidate old requests. Tests cover cache hit/miss/failure and reactivation; cancelled fetches reject and old XHR work is suppressed. |
| A06 | Cache consistency | A new cache read could precede the pending write announced by a newer creator state, returning old data. | Await the serialized cache write, recheck the state generation, and fall back safely after failure. Deferred transactions prove no old cached response is delivered. |
| A07 | Configuration concurrency | Gist creation, PATCH completion, or 404 replacement could overwrite a newer Gist choice or resurrect an ID after defaults were restored. | Compare the original enabled/token/ID snapshot and save inside one configuration mutation. Keep network work outside the queue. Nine mocked concurrent-change regressions failed before the repair; unchanged uploads and queue recovery also pass. A remote upload may finish before the conflict is reported; newer local settings remain intact. |
| A08 | Transport lifecycle | Supplying a cancellation signal replaced the default GET deadline, allowing task-detail reads to remain pending indefinitely. Lowercase HTTP methods also bypassed the old check. | Combine caller cancellation and the 15-second deadline for HTTP/native GETs in one transport helper. Logs reuse it. Tests verify timeout, preserved caller state, and no request replay. |
| A09 | Settings consistency | During an awaited runtime save, another settings read could advance the shared defaults revision. The later defaults POST then paired old values with the newer revision. | Capture values and revision together before awaiting any earlier save. Regression advances the revision during the wait and confirms the original precondition is sent; the form remains inert during saving. |
| A10 | UI accessibility | Returning from task details after a 304 or unchanged-content 200 skipped row rendering and never restored the original details button's focus. | Restore return focus independently of row changes, consume the target once, and respect focus the user moved elsewhere. Real Chromium tests reproduce both response paths; a unit regression guards against later polling reclaiming focus. |

The output reservation repair does not resolve symlink aliases or move existing
downloads. Recovery continues to validate both cleanup paths and refuse unsafe
targets. Other processes can still interfere with files outside TrueDown's
ownership model; no new filesystem-wide scan or deletion was introduced.

## Review coverage

| Area | Boundaries reviewed |
| --- | --- |
| Extension background | RPC registration and sender checks, handler routing, generation-based history import/export, creator flags, configuration mutation ordering, network host/cookie/size limits, download batches and terminal completion, native fallback, Watch state, and Gist updates. |
| Extension page bridge | Creator cache transaction order, fetch/XHR reuse and cancellation, pagehide/bfcache generations, and failed IndexedDB reads/writes. |
| Go service | HTTP decoding and authentication changes, output reservations and indexes, single/batch task submission, transfer intent, recovery/cleanup ownership, and relevant existing persistence and request-boundary tests. |
| Web frontend | HTTP/native transport, settings revisions and drafts, task list ETags, details navigation, focus and busy state, logs, native forms, and shared component contracts. |
| Rust native shell | Request allowlists and credential redaction, bounded framing, connection/shutdown recovery, window roles/navigation/capabilities, startup registration, profile helpers, directory pickers, and update-health/recovery boundaries. No additional confirmed Rust finding required a source change. |
| Build and dependencies | Locked native dependency provenance, icon/UI generated mirrors, Go/npm/Cargo advisory scans, extension staging, native preparation, release-note selection, Python archive validation, and Unix output/signing-environment guards. |

This is a broad audit of critical boundaries and changed behavior, not a claim
that every line or every external service state was exhaustively verified.
Each repair group received a separate read-only review by another agent.

## Verification

| Check | Result |
| --- | --- |
| Final Node repository suite | 344 tests: 343 passed, one Unix-only process-group test skipped on Windows. |
| WSL native acceptance contracts | All eight passed, including the real descendant cleanup regression skipped on Windows. |
| Python history migration | 13 passed. |
| Python release validation | 27 passed. |
| Windows Go suite | `TRUEDOWN_INTEGRATION=1 go test ./...` passed, including real aria2 lifecycle, partial-file recovery, and group-directory output tests. |
| Windows Go static checks | `go vet ./...` passed. |
| WSL Go suite | Fresh cross-compiled test binaries for all 11 test packages passed; app/downloader tests use real Linux aria2. |
| WSL core lifecycle | Ping, SQLite/tasks, single-instance behavior, aria2 cleanup, and dashboard exit passed. |
| Rust | Formatting, `cargo clippy --locked --all-targets -- -D warnings`, 26 unit tests, and one URLPattern dependency regression passed on Windows. |
| Browser acceptance | Workspace, settings, task forms, file groups, and auxiliary UI all passed in headless Chromium. Settings cover 1040/820/390 widths with both themes; forms include 200% scale; groups cover 1200/390 widths and both unchanged-response focus paths. |
| Native Windows build | Fresh debug shell/core/CLI and bundled frontend built successfully for product 1.6.5; license preparation verified 284 native dependency notices. |
| Hidden Windows acceptance | All four windows, role permissions, task creation, retained drafts, auth, scaled layout, themes/fallbacks, core recovery, external exit, orphan cleanup, and shell crash cleanup passed. All windows stayed hidden. |
| Private-pipe smoke | Ownership, independent-service attachment, private auth, EOF, HTTP exit, and pipe exit passed. |
| Live task-settings smoke | Speed updates, paused connections, private details, group filtering, and restart persistence passed. |
| Dependency scans | npm audit: zero findings; govulncheck: no vulnerabilities found; cargo-audit: zero vulnerabilities or warnings across 516 locked packages. RustSec snapshot: `b50980aad8b8f14f77e25a97b32dd94bf008b0af`, dated 2026-09-09. Local patched-source hash tests also passed; no version labels or advisory exclusions were changed. |
| Generated resources | Canonical UI mirror and all 15 icon assets/notices match their sources. |
| Extension release checks | Product version 1.6.5, clean unpacked build, and both product changelog selectors passed. |
| Unix release guards | Output symlinks, release identity, native targets, and optional macOS signing-environment checks passed. |
| Diff checks | No whitespace errors; unrelated starting changes did not exist. |

Full command logs are retained locally in `truedown/dist/audit-2026-09-12/`.
Browser fixtures retain their screenshots in the temporary directories reported
by their drivers and in `truedown/dist/file-group-review/`. These generated
artifacts are ignored and are not part of source commits.

One intermediate Node run rejected the newly added release notes because their
verification paragraphs lacked the required heading. The notes were corrected
to the existing contract before the successful final run. An initial combined
Python command used the wrong module search path for release tests; running
unittest discovery from the tools directory passed all 27 tests. Neither case
required a runtime workaround or weakened assertion.

## Coverage limits

- Native macOS execution, Linux Tauri GUI acceptance, the optimized Linux GLib
  regression, full five-platform package builds, signing, and actual release
  publication were not run in this Windows/WSL session.
- No new race-detector run, live Aria2 Next torrent swarm, authenticated supported
  website, real Chrome action-popup check, or live Gist upload was performed.
  Extension UI styles, popup width, injection order, permissions, and storage
  schemas are unchanged.
- Hidden Windows geometry/native paint acceptance is not visible caption
  composition verification. No visible-window test was requested or opened.
- Advisory scans describe the available databases at the time of this run;
  they do not establish absence of unknown vulnerabilities.

All confirmed findings listed above are repaired. The limits describe validation
coverage, not additional confirmed defects left unfixed.
