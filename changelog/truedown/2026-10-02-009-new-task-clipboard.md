# TrueDown new-task clipboard import

## Changes

- Capture the clipboard once when New download opens. Parse and deduplicate bounded HTTP(S)/Magnet links natively, returning only task links to the owning form.
- Preserve existing sources and edits made while reading. OS drops take priority. Clipboard import never starts downloads and focus changes never reread the clipboard.

## Verification

- Native link parsing and frontend concurrent-edit/draft tests passed.
- Hidden native acceptance verified caller restrictions and that tests never read the actual user clipboard.
