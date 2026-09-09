# TrueDown - Bounded Linux native acceptance cleanup

- Run the Linux automation driver in its own process group. Stop descendants
  that retain output pipes after the driver exits, using bounded TERM/KILL waits.
- Bound driver readiness, core exit and session deletion requests; close fixture
  connections during cleanup and report the active acceptance phase on failure.
  The WebKitGTK CI step also has a ten-minute outer timeout.
- Retain the native shutdown, Windows CRLF and package-visibility corrections
  from the preceding build. Product version remains 1.6.3.

## Verification

- A real process-tree regression demonstrates that killing only the parent
  leaves its output pipe open; group cleanup terminates the stubborn descendant.
- Full WebKitGTK acceptance passes inside Xvfb with the updated core, including
  native windows, task forms, live preferences, permissions, settings, layout,
  retained drafts and close-to-hide behavior. The test process exits cleanly.
- Actionlint validates the native workflow. The previous commit's Linux x64,
  Linux ARM64 and macOS ARM64 package jobs have passed on GitHub.
