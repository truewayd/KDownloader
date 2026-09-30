# KDownloader 2.0.4: visual alignment and download feedback

- Align popup, settings and injected controls with TrueDown neutral light/dark surfaces, system typography and shared corner sizes, preserving the 360 px popup.
- Show localized notifications for incomplete posts, partial submissions and failed download requests; aggregate batch failures and keep user cancellation quiet.

- Shared extension toast styling now fades and slides in and out, with immediate dismissal hit-target removal and reduced-motion support.
- Keep toast outlines low contrast and checkbox check strokes fine.

## Verification

- Full Node suite: 379 passed, one skipped; shared UI mirror check, 13 history migration tests and clean extension build passed.
- TrueDown browser fixtures exercise the corresponding toast lifecycle; real Chrome popup acceptance remains separate.
