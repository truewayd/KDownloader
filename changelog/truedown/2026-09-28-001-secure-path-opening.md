# TrueDown interface and secure path opening

- Refine rounded option lists, narrow-window navigation, All downloads context menus and aligned settings blocks with subtle surface shadows.
- Open Windows files and folders through a bounded hidden helper and the Windows shell API, avoiding repeated Explorer startup.
- Accept targets only from an inherited pipe belonging to a live core parent running the same executable; reject command-line paths and arbitrary shell arguments.
- Restrict opening to local folders and explicitly allowed data formats. Reject scripts, executables, shortcuts, disguised executable headers, remote/device paths, alternate streams and reparse points.
- Retain path handles during dispatch to prevent replacement, and preserve completed-task ownership checks for file requests.

## Verification

- Windows Go regression suite and vet, including helper isolation, parent identity, bounded input, path validation and replacement prevention.
- JavaScript regression suite and shared UI mirror check.
- Workspace, settings, context-menu and custom-select browser acceptance in light/dark themes and narrow viewports.
