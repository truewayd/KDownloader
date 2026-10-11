# KDownloader 3.1.0: MEGA link fragments

- Recognize encoded hash separators in modern MEGA file/folder links during external-link extraction.
- Decode only the path separator and retain the URL authority and query parameters.
- Preserve modern, legacy and HTML-encoded MEGA fragment keys in extracted links and TXT exports.
- No MEGA download backend is added.

## Verification

- Focused external-link extraction tests, UI mirror check, Python migration tests and extension build passed.
