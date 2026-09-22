# Intentional text selection

- Disable accidental text selection on application chrome, navigation, labels and buttons.
- Keep text selection in inputs, editable content, task-detail values, logs, status/error messages and confirmation explanations. Context-menu copying restores the selected content.
- This release also includes project-themed confirmation dialogs and context menus, and removes the duplicate native task-details Close button.
- Include the required verification records in release notes and run cross-platform validation when those notes or their selector change.

## Verification

- Actual drag selection and menu copy behavior passed in both light and dark browser fixtures.
- Workspace, settings, new-task, task-details and file-group browser acceptance passed; Windows hidden-window acceptance and the desktop debug build passed.
