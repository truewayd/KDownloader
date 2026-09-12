# KDownloader - Cache and configuration consistency

- Wait for announced creator-cache writes before reading cached data; fall back
  safely after failed writes.
- Reject pending fetch/XHR completions across page cleanup and bfcache restore,
  preventing stale responses and delayed fallback requests from the old page.
- Preserve valid creator flag identities whose JSON tuple keys expand when
  quotes or backslashes are escaped.
- Commit uploaded Gist IDs only when the original configuration still matches.
  Changing the token, selecting another Gist, or restoring defaults during an
  upload preserves the newer settings and reports the conflict.

## Verification

Focused lifecycle, history, configuration, and mocked Gist
regressions pass. No live Gist account was changed during validation.
