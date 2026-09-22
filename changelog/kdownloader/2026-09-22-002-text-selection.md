# KDownloader 2.0.2

- Disable accidental selection of popup/settings navigation, labels and buttons while preserving inputs, diagnostics and confirmation explanations.
- Keep external URLs selectable inside the shared links dialog. The rules stay within extension pages and owned Shadow DOM and do not affect host-site text.
- Synchronize the canonical component runtime with TrueDown.

## Verification

- Repository JavaScript tests, shared UI mirror verification and the clean extension build passed locally.
- All 13 history migration tests passed under WSL/Python.
