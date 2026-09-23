# Native window and taskbar icons

Settings, new-download and task-detail windows now use their own generated role icons. Windows supplies the same full-resolution icon to both the window and the taskbar; the main window retains the TrueDown brand.

## Verification

- Rust tests and Clippy passed.
- Hidden Windows acceptance verified native icon pixels differ from the main window, taskbar and window icons match, and native captions, material fallbacks, crash cleanup and retained drafts remain functional.
- Generated icon source checks passed.
