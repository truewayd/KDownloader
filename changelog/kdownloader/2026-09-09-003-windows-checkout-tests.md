# KDownloader - Windows checkout test compatibility

- Accept both LF and CRLF when locating the Pawchive download function and
  patched Cargo packages in source-contract tests. Exercise both newline forms
  on every platform, preserving incomplete-post checks and dependency provenance.
- Keep vendored source and notice hashes byte-exact. Product version is 1.6.3.

## Verification

- A fresh Windows checkout with `core.autocrlf=true` reproduced both CI failures.
- All 24 focused tests and all 317 repository tests pass in that checkout.
- Shared UI consistency, the 13 Python migration tests, extension packaging and
  product-specific changelog selection pass locally.
