# Background utility reuse and test isolation

- Reuse the bounded UTF-16 validator for history identities, preserving the
  existing identity limits and rejection messages.
- Parse each external-link URL once during filtering and TXT generation while
  retaining HTTP(S) checks, domain filtering, deduplication and MEGA source links.
- Exclude generated output, dependency trees and non-regular files from locale
  scanning so concurrent builds cannot invalidate the test's source inventory.

## Verification

- Focused history, link-filter and Watch tests; full `npm test`.
- `npm run ui:check`, Python history migration tests and clean extension build.
- Full Node tests also run concurrently with the extension build to exercise
  the locale scanner's generated-output exclusion.
- No UI, RPC, manifest or durable storage format changes.
