# Post download failure notifications

- Show localized system notifications for failed post requests, partial file submission and incomplete Pawchive posts, including posts with available external links.
- Summarize batch failures in one notification, retain the existing backend fallback confirmation, and keep user cancellations quiet.
- Include bounded post identities and file/post counts without exposing raw backend errors. Notifications describe request/submission outcomes; they do not verify final backend file transfers.

## Verification

- Automated download RPC, fallback and localization regression tests; full Node suite, UI mirror check, history migration tests and clean extension build.
- Real Chrome/system notification display and live-site acceptance require separate manual verification.
