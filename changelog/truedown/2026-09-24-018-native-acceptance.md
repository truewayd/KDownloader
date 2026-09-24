# TrueDown: native menus and faster safe exit

- Preserve native menu positioning, rounded framing, immediate dismissal and system-font rendering.
- Accelerate safe Windows engine exit with a bounded console interrupt that preserves checkpoints and NEXT native HTTP resume state, including when the parent ignores CTRL+C.
- Resolve strict Rust Clippy checks across Windows, Linux and macOS.
- Fix Windows hidden-window group persistence acceptance: CI acknowledged CDP text insertion without changing the field. Set the fixture value and dispatch input/change together, then assert the draft, completed save and backend value. Keep visible native editing and clipboard acceptance separate.

## Verification

- Windows CI verifies four safe-exit paths in 0.68-0.89 seconds.
- Stable aria2 and NEXT checkpoint/resume regression tests pass.
- All native builds and acceptance checks remain required before publication.
