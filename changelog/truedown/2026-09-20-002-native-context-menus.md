# Native content context menus

- Replace desktop WebView content menus with reusable operating-system popup
  menus created during shell setup, without adding a WebView window.
- Add context-aware task and workspace actions, native text editing menus,
  password-safe choices, and keyboard invocation.
- Preserve existing task confirmations and reject stale task actions after
  polling or navigation; constrain menu requests by caller window and action.
- Add browser behavior acceptance and hidden native IPC checks. See
  `truedown/docs/context-menus.md` for the design and validation boundaries.

## Verification

- Passed 33 Rust tests, 347 JS tests (one skipped), 13 Python migration tests,
  Go tests and vet, shared UI verification, and extension build.
- Passed context-menu, workspace and task-form browser acceptance.
- Windows hidden native acceptance covers display suppression and role rejection;
  it does not claim visible popup composition or interactive editing verification.
