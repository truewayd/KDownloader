# System dialogs, window titles and spacing

- Restore meaningful settings captions and add settings, download and information icons to auxiliary title strips using the canonical icon sprite.
- Reduce divider lines in settings groups, action footers, task details and advanced download fields. Headings and spacing keep sections readable.
- This release also moves desktop confirmations to parented operating-system dialogs with localized titles and information/warning/error kinds. Large forms remain independent native windows; Toasts and compact pickers stay lightweight.

## Verification

- Frontend suite: 358 passed, one conditional skip. Rust tests and Clippy, Go tests and vet, shared UI/icon checks and the extension build passed.
- Browser acceptance covered light/dark themes, 100%/200% scale, compact layouts, titles, draft retention, confirmation cancellation, task details and context menus.
- OS dialog display is suppressed in hidden Windows acceptance. Native UI appearance on macOS/Linux is left to platform validation; browser layout checks are not native visual checks.
