# TrueDown - queue, resource and UI audit

Completed-record cleanup now leaves bounded aria2 result reclamation to the
engine, preserving results not yet observed without issuing per-history RPCs.
Stopped-result polling reads a bounded recent window so accumulated historical
failures cannot hide new completions or grow engine memory indefinitely. Stale
polls cannot overwrite newer pause/resume intent, and engine exit or cancellation
during task admission preserves recoverable task state.

The dashboard preserves row-operation state and keyboard focus across polling,
does not discard selection after failed removal, coalesces settings opening and
retains successfully saved settings after a partial failure. Unix SQLite scans
reuse their argument bindings, and Windows tray labels keep valid Go references
through native calls.
Mobile settings and download modals now scroll their body within the viewport
while keeping header and footer actions reachable by mouse and keyboard.

Unix builds reject inconsistent release version/build metadata and overflowing
build numbers before touching output. Native CI now runs the build-safety fixture.

## Verification

Added queue lifecycle, native-menu GC, SQLite scan and Unix build-metadata
regressions. The audit includes Go tests and static analysis, native lifecycle
checks, dashboard browser fixtures and allocation benchmarks; final results and
coverage limits are recorded in `docs/project-reaudit-2026-09-05.md`.
