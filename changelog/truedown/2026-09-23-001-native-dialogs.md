# Native confirmation dialogs

- Desktop confirmations for removal, exit, updates and risk acknowledgment now use parented operating-system dialogs with explicit titles and information, warning or error icons.
- Native dialog requests are bounded per window and retain their slot until the OS callback finishes. Dialog errors never approve an action or open an in-page fallback.
- New downloads, settings and task details remain independent native windows. Toasts and compact pickers retain their lightweight presentation.

## Verification

- Confirmation dispatch, severity, cancellation and failure-path unit tests passed.
- Light/dark new-task browser acceptance passed at 200% scale, including retained drafts and native confirmation results.
- Native callback ownership and text validation tests passed. Platform validation continues in the release workflow.
