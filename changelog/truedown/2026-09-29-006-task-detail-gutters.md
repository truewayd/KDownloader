# TrueDown - NEXT 2.8.3 and native window compatibility

- Adapt HTTP checkpoint recovery and filename resolution to aria2 NEXT 2.8.3, with pinned real-engine acceptance in CI.
- Restore native auxiliary-window opening transitions while retaining live WebViews and drafts. Reapply Mica and caption theme before showing replacement native windows.

- Restrict narrow-screen sidebar reservation to the main workspace. Standalone task details no longer inherit an extra 56px empty strip on the left; both gutters remain 8px.

## Verification

- Go unit/vet checks, Windows stable/NEXT engine integration, WSL package/core smoke, and repository tests are recorded in the NEXT compatibility audit.
- 44 Rust tests, hidden Windows desktop acceptance, and nine visible auxiliary reopen scenarios across light/dark/forced-color modes.
- Task-details browser acceptance at 640px and 520px in light and dark mode, including explicit gutter assertions.
- Main workspace responsive acceptance and native task-detail geometry check.
