# Windows update restart and task list performance

- Opening TrueDown during an automatic update requests the main window after installation or rollback. Manual update restarts reopen the main window. A background launch can use its existing window on first display.
- A mismatched replacement build exits before starting its core. A failed startup health check triggers shutdown so the updater can restore the previous version. Replacement and rollback each share a bounded retry period for Windows file locks.
- Update preparation verifies each copied file against its expected hash before publishing it, with fewer full-file reads.
- Category pages allocate less memory when sorting by file name and skip empty status groups. Refreshing task counts reuses the cached row size. Empty category and module views now describe the active filter.
- The core reports readiness as soon as its HTTP or HTTPS listener is registered. Packaged workspace windows load their styles and deferred application scripts in two local requests.
- Native windows skip initialization for unrelated settings, search and task-list controls. Engine settings read file group definitions without constructing the file group editor. Returning to an initialized settings category displays it immediately.
- About loads project information when opened and the complete packaged license text when expanded. Reopening the disclosure can retry a failed load.
- Opening About shares one update-state read with the settings controls. Unchanged updates and file-group revisions avoid rebuilding controls during polling. Typing a file-group edit reads only the edited row until save or reconciliation.

## Verification

- Windows update handoff, rollback, desktop and task-list regression checks use isolated profiles.
- The Windows opening benchmark compares fresh profiles with alternating builds and measures main document readiness, editable settings, category navigation and retained-window commands. Measurements use hidden WebView2 windows.
