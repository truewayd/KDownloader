# Searchable settings with automatic saving

- Settings use their own native taskbar icon and omit the in-page window caption. The sidebar starts with search, uses equal top/left spacing, and temporarily replaces categories with results. Selecting a result navigates to and highlights its setting; search never indexes profile values.
- Program updates are in About. Engine and module controls remain together, and Exit is in the main window and tray.
- Settings, tray preferences and file groups save when changed, with no bottom save bar or save buttons. Text fields commit when editing finishes; invalid or failed edits remain available for correction. Serialized group saves cannot overwrite newer input, and conflicts preserve local edits while adopting untouched remote values.
- Category headers provide Restore defaults with confirmation. File-option resets preserve custom groups; each reset is scoped to its category.
- Persistent on/off settings use switches, while task and extension selection retain checkboxes. Separate backgrounds and spacing distinguish groups. Short labels and expandable help replace long descriptions.

## Verification

- Frontend tests, history migration tests, shared UI and icon checks.
- Light/dark browser acceptance at desktop and mobile widths: search, highlighting, switches, keyboard input, immediate persistence, rejected resets, save failures, groups and revision conflicts.
- Windows hidden native acceptance: role-specific taskbar icons, retained drafts, settings persistence, window geometry, themes, material fallbacks and crash cleanup.
- Rust tests/Clippy, Go tests/vet, WSL tests and Linux core startup checks.
