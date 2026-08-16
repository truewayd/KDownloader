# Embedded provider links

- Detect HTTP(S) links stored in a post's `embed.url`, including Dropbox folder links, when exporting or aggregating external links.
- Apply the same post link parsing to Pawchive and Kemono/Coomer API responses while preserving content-link deduplication.
- Add an editable external-link domain blacklist, enabled by default with `patreon.com` (including subdomains), and a no-filter mode in settings.

## Verification

- `npm test`
- `pwsh -NoProfile -ExecutionPolicy Bypass -File tools/build-extension.ps1`
