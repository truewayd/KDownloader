# Stable download outputs and recoverable retries

- Pin HTTP output ownership before engine admission. Retries and process
  recovery reuse the recorded name instead of accumulating numbered partials.
  New tasks continue to reserve separate collision names and protect foreign
  payload/control pairs.
- Separate failed-task retries from completed-file conditional refreshes.
  Missing piece maps cannot turn sparse or preallocated files into false
  completions; unusable owned data restarts at the same path.
- Persist transfer intent and previous engine GIDs in record schema 7. Failed
  retirement cannot lose an older writer, and stale queued work cannot apply
  obsolete retry instructions.
- Detect malformed HTTP resume maps behind generic engine errors using bounded
  structural inspection. Validate both cleanup paths, reject other task owners,
  and preserve resolver verification and native BitTorrent layouts.
- Document naming, retry, integrity, migration, and historical-leftover rules
  in `truedown/docs/download-retry-rules.md` and the platform READMEs.

## Verification

- Regression coverage for repeated retries, duplicate submissions, missing and
  corrupt maps, schema migration, persisted restart intent, filename collisions,
  stale GIDs, active writers, unsafe paths, and failed persistence.
- Real aria2 fixtures compare SHA-256 after interrupted transfers, valid range
  resumes, missing-map process recovery, corrupted-map recovery, and completed
  conditional refreshes; directory checks reject numbered leftovers.
- Windows: `TRUEDOWN_INTEGRATION=1 go test ./...`, `go test ./...`, and
  `go vet ./...` passed.
- Linux/WSL: cross-compiled package tests with real aria2 integration and
  `tools/smoke-linux.sh` passed, including SQLite, task operations, single
  instance behavior, engine cleanup, and clean dashboard exit.
- Repository checks: shared UI mirror, Node suite (317 passed, one skipped),
  Python migration suite (13 passed), extension build, product changelog
  selection, and `git diff --check` passed.
