# TrueDown draft retention and log-copy state

- Preserve dirty and saving task-detail drafts when visiting more than 32 tasks. Information views allocate no settings draft; clean snapshots are reclaimed first. When all slots contain unfinished edits or saves, show an explicit limit without discarding edits.
- Keep log-copy disabled while a clipboard write is pending. Empty refreshes remain disabled after completion, and refreshed content, native disabled state and ARIA state stay consistent after success or failure.

## Verification

Targeted concurrency and capacity regressions; task-detail browser checks at two window sizes in both color schemes; settings checks at 1040px, 820px and 390px. Browser native transport and clipboard operations are fixtures; these checks do not certify native compositor behavior or a packaged release.
