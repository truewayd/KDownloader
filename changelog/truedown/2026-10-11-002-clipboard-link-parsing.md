# Clipboard refresh and pasted links

- Reopening New download refreshes untouched clipboard-filled links while preserving manually edited sources and torrent drafts.
- Extract and deduplicate HTTP(S)/Magnet links from pasted text without submitting tasks automatically.
- Preserve modern and legacy MEGA fragment keys and recognize encoded hash separators in modern MEGA links.
- Preserve punctuation in standalone URLs and keep wrapper trimming linear on large pasted text.
- MEGA downloading remains research-only; no download engine or module is added.

## Verification

- Focused clipboard/link tests and Chromium native-form fixtures passed in light and dark mode.
- Native clipboard behavior is covered by Rust parser tests; real system-clipboard/window acceptance remains separate.
