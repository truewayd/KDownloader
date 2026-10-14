# KDownloader filters and TrueDown rule synchronization

- Add off, Engineering-group and custom suffix modes to KDownloader settings,
  with a one-way TrueDown source switch and explicit synchronization action.
- Replace outgoing TrueDown writes with authenticated bounded GETs. Resolve
  project mode from the current Engineering group; preserve custom null and
  explicitly empty lists, provider folder modes and local-only credentials.
- Keep networking outside the shared configuration mutation queue. Reject
  stale commits after newer rule/backend writes or restored defaults, and
  retain saved filters when synchronization fails.
- Preserve legacy disabled-sync choices and remove the outgoing flag on save.
- Restore Kemono/Coomer, Pawchive and CoomerFans file filtering, confirmed in
  the original July implementation. Validate trusted media before filtering;
  fully filtered posts retain links and never write download history.
- Keep TrueDown's live folder filtering separate from ordinary core HTTP
  tasks and KDownloader's local media selection.

## Verification

- Actual loaded Chrome extension in light/dark 1040px and 390px viewports:
  modes, saved normalization, keyboard synchronization, changed Engineering
  suffixes, explicit empty lists, authentication failure and backend drafts.
- Node tests for one-way requests, cookie omission, bounded parsing, stale
  commits, legacy preferences, compound suffixes and supported site dispatch.
