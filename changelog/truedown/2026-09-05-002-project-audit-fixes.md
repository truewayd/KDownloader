# TrueDown: project audit fixes

- Keep native BitTorrent save roots and pause/resume intent when reattaching or restoring tasks, and track metadata children before declaring completion.
- Cancel Dropbox preparation during shutdown while preserving queued task intent for restart.
- Release the task-operation lock during cloud resolver requests, then validate the current task identity and pause state before admission.
- Prevent stale task responses and bodyless ETag reuse from displaying the wrong task page; preserve busy controls during polling and show task-operation errors.
- Respect the automatic-update setting for staged updates and publish new preferences or verified metadata only after a successful settings write.
- Validate complete HTTP origins and bound malformed UTF-8 log handling without losing the remaining diagnostic text.
- Reject nonregular Unix instance locks and symlinked Unix build output roots; isolate Linux smoke-test executables in their private temporary directory.
- Add regressions for task lifecycle, persistence failures, network cancellation, origins, logs, and dashboard state.
- This release also includes the pending Unix release work: Linux amd64/arm64 and macOS Intel/Apple Silicon packages, native-platform build jobs, and complete six-asset validation alongside the existing Windows self-update format.

## Verification

```text
npm test
python -m unittest discover -s truedown/tools -p test_validate_release.py
cd truedown
go test ./...
go vet ./...
pwsh -NoProfile -ExecutionPolicy Bypass -File build.ps1 -OutputDirectory dist/TrueDown-audit
pwsh -NoProfile -ExecutionPolicy Bypass -File tools/prepare-wsl-tests.ps1
wsl -d Ubuntu -- bash tools/run-linux-tests.sh dist/wsl2/tests
wsl -d Ubuntu -- bash tools/smoke-linux.sh dist/wsl2/TrueDown
wsl -d Ubuntu -- bash tools/test-unix-build-safety.sh
```

Chrome dashboard checks use mocked APIs at desktop/mobile widths in both color
schemes. macOS native package validation remains in the platform CI jobs.
