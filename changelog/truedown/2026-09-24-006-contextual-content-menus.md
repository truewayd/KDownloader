# Context-aware content menus and retained window focus

- File-group menus now offer viewing, focused editing, adding and managing groups.
  Adjustments open the existing File management editor with retained drafts.
- Navigation whitespace offers group management; task-list whitespace offers only
  enabled queue actions and the default download directory. Queue-wide actions are
  explicitly labeled so a filtered group cannot imply a narrower operation.
- Task rows retain status-dependent actions and batch selection. Dispatch checks
  the original task/group identity and current control availability again.
- Group navigation uses a bounded, main-window-only native command and consumes
  focus/add intents once after settings initialization. Editing menus retain their
  selection, keyboard and password protections.
- Mouse-opened native menus keep the caller active and do not steal window focus.
  Keyboard navigation is relayed through a caller-bound command; menus opened
  explicitly by keyboard retain native focus navigation.
