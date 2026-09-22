# TrueDown task details window and unified download creation

- Open task details in a separate singleton native window while keeping the main list's filter, selection and scroll position. Information, per-task settings and download actions remain available.
- Retain settings drafts and the current tab when reopening the same task. Stop detail polling on close, reject stale task-selection events and responses, and refresh the main list after successful detail changes.
- Remove the redundant batch-download button, context-menu entry and native window. New Download accepts one link per line, with the existing single torrent-file import and partial-failure retry behavior.
- Restrict the details window to its task operations; it cannot poll the full task list, change application preferences or open a directory picker.

## Verification

- Native Rust permission and request-bound tests; frontend tests for window lifecycle, stale selection state and hidden-window polling.
- Windows hidden native acceptance exercises separate details, singleton reopen, retained tabs and role restrictions.
- Chromium checks light/dark details and settings at normal and narrow sizes, task actions, draft retention, stale reads, conflicts and keyboard dismissal; unified form tests cover file import, preferences, submission and scrolling.
