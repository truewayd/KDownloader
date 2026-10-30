# KDownloader popup read ordering

- Reject superseded backend, feature-visibility and history-stat responses, including late failures, so older requests cannot overwrite newer popup state.
- Preserve the real Chrome action popup's 360px width and existing failure feedback for the latest request.

## Verification

Reverse-order success/failure regressions and the real action popup in both color schemes with a controlled message fixture. Full Node suite, migration tests, UI mirror and extension build checks passed. Site reinjection checks use synthetic supported-site pages.
