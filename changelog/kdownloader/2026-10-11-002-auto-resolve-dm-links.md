# Automatic cloud resolution and shared DM link history

- Add an opt-in automatic Google Drive/Dropbox dispatch switch with backend capability detection. Unsupported ABDM/Gopeed backends cannot enable it.
- Keep failed or unhandled links available to the frontend. List backend-confirmed links separately at the bottom of the exported TXT.
- Optionally include Pawchive DMs in creator/page fetches, including pages with no new posts. Posts and DMs share a local complete-link ledger; failed attempts also deduplicate, while keyless MEGA links remain exportable.
- Add settings to mark complete links as extracted or allow them to be processed again. Restoring settings preserves link records.

## Verification

- Extension suite: 408 passed, 1 skipped; Python migration suite: 13 passed. Shared UI mirror check and clean extension build passed.
- Settings browser fixture checked unsupported-backend rejection and 390px layout; installed Chrome extension acceptance remains unverified.
- Backend acceptance is task dispatch, not final downloaded-file verification.
