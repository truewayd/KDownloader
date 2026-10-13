# TrueDown tooltip sessions across native window renewal

- Keep the native tooltip session with the retained WebView instead of the replaceable native window. Closing and reopening a window preserves its tooltip bridge and revision ordering.
- Rebuild caption clipping from the shared tooltip state during theme/composition refreshes. Preserve native caption controls, bounded rounded reveals and lifecycle dismissal.
- Accept bounded hover-tooltip layouts in visible inactive windows. Focus changes refresh composition without independently discarding the document's current tooltip layout.
- Wait for native composition readiness before painting the shared tooltip, avoiding a clipped first frame during asynchronous IPC. Pending layouts remain measurable; dismissal or a newer layout invalidates late acknowledgements across all native windows.
- Cover repeated native shell replacement, old-message rejection, state release, and inactive light/dark tooltip composition on main, settings, new-task, task-details and task-preview windows. Acceptance uses native mouse hover without activating the window; main-window acceptance hovers the real download-directory control.
- Native visual acceptance uses Cargo's actual development executable and records its SHA-256, rather than silently selecting an older packaged executable in the same build directory.

## Verification

- `npm run ui:check`
- `npm test`
- `npm run test:tooltips` in `truedown/desktop`
- `cargo test --locked` and `cargo clippy --locked --all-targets -- -D warnings` in `truedown/desktop`
- `node truedown/desktop/tests/windows-caption-visual.mjs --visible`
- `node tests/windows-smoke.mjs target/debug truedown-desktop.exe` in `truedown/desktop`
