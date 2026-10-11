# Cloud-link integration and aggregated download issue notifications

- Add a versioned KDownloader capability/resolve namespace without modifying ABDM payloads or ordinary fallback behavior.
- Reject automatic dispatch when a module is disabled or cannot resolve a link, preserving links for frontend handling.
- Count new task errors and module issues without exposing URLs or credentials. The native shell aggregates notifications independently of window visibility.
- Windows replaces one profile-scoped notification silently after the first popup. Linux updates its notification; macOS uses rate-limited summaries.

## Verification

- Go full suite and vet passed, including capability detection, disabled/unsupported modules, deduplicated dispatch and issue transitions. WSL tests and core smoke passed.
- Windows native Rust suite: 51 passed. Linux/macOS native notification display has not been accepted.
- Native aggregation tests cover history suppression, throttling and core restarts. Actual notification display remains platform-dependent.
