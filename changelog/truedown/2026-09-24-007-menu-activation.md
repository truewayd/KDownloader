# TrueDown: reliable context-menu actions

- Keep native menu cancellation separate from WebView blur, so clicking group,
  task, workspace and editing actions can complete while the caller stays foreground.
- On Windows, distinguish OS foreground activation from WebView keyboard focus;
  restore the original caller's keyboard target after dismissing a mouse menu.
- Report action failures even after the menu has closed.
- Add caller-blur regression coverage and real Windows mouse-click acceptance for
  group routing and editor selection.

## Verification

- Browser menu regressions pass for caller blur, action failure reporting, stale
  targets, editing ranges and keyboard navigation in light and dark themes.
- Rust desktop unit tests, the Go core suite/vet, and WSL Linux tests/startup smoke pass.
- Repository tests: 366 passed, one skipped; group, workspace, form and settings
  browser suites and hidden Windows native acceptance pass.
- The visible OS-click fixture was blocked by foreground-window ownership on this
  desktop; actual mouse delivery and foreground retention still need acceptance.
