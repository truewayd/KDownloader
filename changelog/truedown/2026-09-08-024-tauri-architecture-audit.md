# TrueDown 1.6.3 - Tauri architecture audit

- Separate native IPC and native form lifecycle from application startup and task orchestration.
- Replace implicit window permissions with explicit role allowlists; reject control characters and ambiguous headers before a request can disrupt the private core pipe.
- Bound profile probes by time and streamed output size, retain directory-picker ownership through cancellation, and keep native exit/startup available during core failure.
- Apply settings loaded during navigation when their category is reopened, retain subsequent drafts, and keep log/task busy state consistent during cancellation and navigation.
- Release native event/material listeners on page teardown, bound frontend read waits, and preserve role-specific window minimum sizes and valid native titles.
- Add regression coverage for permission boundaries, subprocess limits, cancellation, settings navigation and native UI lifecycle.

## Verification

- 310 Node tests, 21 Rust tests, Clippy with warnings denied, Go tests and vet.
- 13 Python history migration tests and 27 release archive validation tests.
- Shared component and icon consistency checks.
- Browser settings, forms, task details and workspace acceptance in light/dark themes at desktop/mobile widths.
- Hidden Windows WebView2 acceptance, Windows release/package smoke, Linux core/integration tests and packaged task-settings acceptance.
- See the [audit report](../../truedown/docs/tauri-audit-2026-09-08.md) for the full validation record and remaining upstream dependency notices.
