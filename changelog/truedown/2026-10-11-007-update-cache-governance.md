# Update cache governance

- Reclaim abandoned application stages and temporary update copies after 24 hours, while preserving pending updates and native recovery transactions.
- Retain the running, selected and previous NEXT engines; reclaim older managed versions and retry superseded download receipts.
- Reclaim signed module-update downloads and queue records after activation. Prune old module versions, embedded baseline caches and abandoned stages at startup before module processes start.
- Preserve ordinary download tasks, user files and resume data. Cleanup is bounded, nonrecursive and refuses unknown contents or directory aliases; failures remain retryable.

## Verification

- Passed focused retention/cleanup tests, the Windows Go suite and vet, WSL Linux integration tests and core smoke, shared UI mirror checks, extension tests (one environment skip), 13 Python migration tests and the extension build. The release-note contract was repaired and its focused suite passed.
- Real installed auto-update/restart and locked-file recovery are not end-to-end desktop acceptance results.
