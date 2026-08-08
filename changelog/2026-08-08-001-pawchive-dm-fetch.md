# Pawchive DM fetch

- Added a Pawchive DMs Creator Fetch mode that scrapes the creator DM page and downloads a TXT export through Chrome.
- DM exports preserve each message's published date, readable text, and link destinations without requiring a media backend or changing download history.
- Restricted HTML fetching to Pawchive creator `/dms` URLs and retained Cloudflare challenge notifications.

## Verification

- `npm test`
- `python -m unittest tests/migrate_history_json_test.py`
- `pwsh -NoProfile -ExecutionPolicy Bypass -File tools/build-extension.ps1`
