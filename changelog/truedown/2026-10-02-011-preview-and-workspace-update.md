# TrueDown preview and download workspace update

## Changes

- Add a resizable, isolated download preview with image zoom, audio/video controls, literal UTF-8 text and explicit file/application/directory actions.
- Enforce task-owned file access, media signatures, pixel/animation budgets, bounded chunks and SHA-256; block active documents, linked paths, remote navigation and preview permission escalation.
- Read and parse the clipboard once when opening New download; preserve drafts and never auto-submit.
- Fix confirmation cancellation being mistaken for initialization timeout, including related native-menu teardown ordering.
- Add global BitTorrent identity settings for NEXT 2.6.7+, keeping HTTP identity independent and preserving partial updates.
- Preserve virtual-list scroll height during selection; add responsive transparent teal empty-state illustrations.
- Extend auxiliary/confirmation Mica through content and footers, retain accessibility fallbacks, and enlarge native desktop icon artwork.

## Verification

- JavaScript: 385 passed, 1 skipped. Go tests and vet passed. Shared UI and all 57 generated icon assets verified.
- Rust: 46 unit tests and 1 dependency test passed; Clippy passed.
- Responsive browser preview/security checks and auxiliary UI regressions passed.
- Windows hidden native acceptance covered real completed-file preview, IPC/capability denials, hide/reopen, task forms, drafts, material/fallback themes, scaling and core lifecycle.
- Earlier workspace validation also covered Python migrations and pinned NEXT 2.8.3 RPC behavior.
- Hidden/browser checks do not establish visible compositor appearance, Explorer icon-cache refresh, visible modal/chooser interaction or OS decoder exploit resistance.
