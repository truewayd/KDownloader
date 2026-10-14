# KDownloader 3.3.0

- Identify Pawchive media requests with the extension version and project URL,
  and send a file Accept header to ABDM/TrueDown and Gopeed backends.
- Preserve the full post referrer and existing trusted-family cookie boundaries.

## Verification

- ABDM and Gopeed payload regression tests, full extension suite, UI mirror check,
  history migration tests and clean extension build passed locally.
