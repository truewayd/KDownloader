# TrueDown desktop icon scale

- Tighten the desktop logo viewport while preserving the original mark and the web logo's layout.
- At 64px, the visible artwork grows from 52px to 60px tall. Regenerate all Windows ICO and macOS ICNS representations from the vector source.

## Verification

- Icon generation consistency and native icon tests passed.
- All 17 updated ICO frames are present in the rebuilt native executable.
- Explorer icon-cache refresh was not verified; no user installation or icon cache was modified.
