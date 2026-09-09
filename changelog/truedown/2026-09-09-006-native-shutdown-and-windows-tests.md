# TrueDown - Native shutdown and Windows dependency tests

- Prepare inherited Unix desktop stdin as a pollable duplicate. HTTP/CLI and
  private-pipe exit now cancel a blocked read even while the native shell keeps
  its writer open, allowing the core and shell to finish graceful shutdown.
- Match patched Cargo packages by complete lines under both LF and CRLF,
  including before Cargo first rewrites a fresh Windows checkout's lockfile.
- Use PowerShell 7 and a visibility-only HWND query for Windows package startup
  acceptance, with a bounded cold-start allowance. The separate native tests
  retain their full caption, hit-test, icon and material checks.
- Preserve reviewed version, local-source and exact vendored-tree checks.
  Product version remains 1.6.3.

## Verification

- Reproduced the dependency contract failure in a fresh CRLF Windows checkout.
- The corrected test exercises LF and CRLF while retaining source-tampering,
  missing-file and unreviewed-file rejection cases.
- A real inherited blocking-pipe regression reproduced the shutdown deadlock
  on Linux before the fix. Native core smoke also checks HTTP and pipe exit
  with the parent writer open, alongside EOF and independent-service ownership.
- Windows Go tests/vet, hidden desktop acceptance and release package startup
  pass locally. Rebuilt WSL Go integration, core lifecycle and private-pipe
  smoke tests pass, including both new active-exit scenarios.
