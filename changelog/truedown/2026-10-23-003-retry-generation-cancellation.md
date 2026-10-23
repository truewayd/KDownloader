# Cancel every retained retry generation

- Canceling a queued or failed retry now stops both its current and previous
  GID, including after restart and when the current GID does not exist yet.
- Wait for both artifact and aria2 writers before partial cleanup. Preserve
  completed outputs and retain task records on stop or retirement failure.
- Deduplicate same-GID retries and reject a GID owned by another task.
- Retire completion/error evidence last so a failed cleanup followed by restart
  cannot reinterpret completed bytes as partial. Missing engine state preserves
  files conservatively while remaining writers are stopped.
- No database schema or dependency changes.

## Verification

- Regression tests exercise queued retries, failed submission, restart,
  offline/failed retirement followed by repeated cancellation, same-GID retries,
  completion races, conflicting GIDs and waiting for an old artifact writer.
- Full Go tests, static checks, builds and integration results are recorded in
  the task report.
