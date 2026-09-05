# KDownloader 1.2.2: audit fixes

- Protect history-generation metadata from import-session RPCs.
- Serialize setting saves, legacy secret migrations, and restore defaults to prevent lost fields and restored credentials.
- Preserve links from incomplete Pawchive posts in creator/page fetches, while retaining the existing media and history restrictions.
- Report creator-page failures and emit an explicit batch completion only after history and link TXT work finishes.
- Keep manually retryable link-only controls available and prevent delayed history lookups from overwriting active download state.
- Discard stale route controls and bound Favorites history lookups to the RPC batch limit.
- Add regressions for persistence, asynchronous completion, and frontend lifecycle behavior.

## Verification

```text
npm run ui:check
npm run version:check
npm test
python -m unittest tests/migrate_history_json_test.py
npm run build
```

Chrome smoke checks cover injected controls and mocked dashboard flows. Real
site/network integrations and the Chrome action popup remain manual checks.
