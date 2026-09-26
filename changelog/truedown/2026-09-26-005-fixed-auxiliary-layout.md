# Consistent navigation and fixed auxiliary windows

- Share the main and settings sidebar width, including narrow-screen layouts.
- Use pill-shaped task and settings search fields.
- Balance the main window logo's top and left spacing.
- Fix settings, new-download, task-detail and confirmation window sizes against
  manual resizing and maximization while retaining monitor work-area fitting.
- Honor fixed window sizing in Windows top-edge hit testing and title double-click
  actions. Keep the main window resizable.

## Verification

- Workspace/settings browser layout checks in light and dark modes.
- Rust window/frame tests and Windows native smoke acceptance.
