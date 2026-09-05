# TrueDown: consistent controls and task feedback

- Align selects, disabled/hover states, checkbox focus, busy indicators and readable light-theme tokens with the shared component system.
- Keep modal focus inside the active dialog immediately, including busy forms; preserve scroll lock and focus beneath nested confirmations, focus Cancel for destructive confirmations, and mark dynamic icons as decorative.
- Prevent repeated new-task submission and stale delayed dialog closes; show successful creation through the same toast flow as settings saves.
- Do not announce a successful refresh when the task fetch failed; preserve busy state during refresh.
- Align task-form connection and retry limits with the settings/backend contract, and honor an explicit zero task speed as unlimited.
- Includes the preceding audit's data/lifecycle/updater fixes and pending Linux/macOS package and release-validation work.

## Verification

```text
npm run ui:check
npm test
cd truedown
go test ./...
go vet ./...
pwsh -NoProfile -ExecutionPolicy Bypass -File build.ps1 -OutputDirectory dist/TrueDown-audit
```

Browser fixtures compare controls and dialogs in both color schemes at desktop
and mobile widths, and exercise task submission, refresh failures, focus, and
keyboard interaction without creating real remote downloads.
