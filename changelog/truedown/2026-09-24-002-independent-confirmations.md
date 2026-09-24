# Independent confirmation windows

- Desktop information, warning and danger confirmations now open separate caller-owned WebView windows with project styling, including Restore defaults and draft replacement.
- A unique identity and one pending slot per caller prevent stale answers and duplicate windows. Parents are disabled until cleanup; Escape, close, hiding/navigation, initialization timeout and cancellation do not authorize actions.
- Popup IPC is restricted to its own initialization and answer. Native failures never fall back to page modals. Browser previews retain their page fallback.

## Verification

- Rust tests, frontend confirmation tests and task-form browser acceptance.
- Windows visible acceptance verifies independent HWNDs, ownership, parent disable/restore, all three severities, cancellation, confirmation and denied privileged commands, and captures only isolated process-owned windows.
