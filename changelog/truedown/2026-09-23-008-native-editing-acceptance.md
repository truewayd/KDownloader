# Native editing acceptance coverage

- Add a shared native editing scenario for menu copy/paste, undo/redo, cut/paste
  and native select-all, with unique fixture text and boolean-only observations.
- Extend Linux Xvfb and macOS debug acceptance; add an explicit visible Windows
  CI runner while retaining the default hidden Windows checks.
- Check every editing action is suppressed in all four hidden Windows roles and
  that WebViews cannot read the clipboard through the plugin command.
- Keep driver deadlines and isolated-process cleanup, and preserve Linux timeout
  diagnostics when the underlying exception has a read-only message property.

## Verification

- Passed Linux native editing and the complete WebKitGTK acceptance under WSL/Xvfb.
- Passed the expanded Windows hidden acceptance, including editor suppression in
  all four roles and clipboard-read ACL rejection.
- Passed context-menu browser acceptance in both themes, the repository JS suite,
  focused acceptance regression checks, 36 Windows Rust tests and shared UI checks.
- Windows visible delivery and macOS native delivery are wired into CI but were
  not run locally; no passing result is claimed for those paths.
