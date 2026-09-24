# TrueDown: native menus and faster safe exit

- Retain native context-menu positioning, rounded framing, immediate dismissal and system-font rendering from the reviewed menu changes.
- Avoid aria2's delayed shutdown RPC with a normal OS interrupt while preserving checkpoint flushing, hidden process ownership and fallback cleanup.
- Preserve NEXT 2.8.2 native HTTP resume state and omit its retired legacy resume option.
- Fix two Rust 1.98 Clippy errors in native menu pixel iteration and reused settings-window routing so strict native builds can pass without suppressing warnings.

## Verification

- Local Rust formatting, all-target Clippy with warnings denied, and native tests.
- Safe-exit and resumed-output integration results are recorded in 2026-09-24-015-safe-exit.md.
- Windows, Linux and macOS build/acceptance jobs run against the pushed commit. Live pointer alignment remains a separate user acceptance check.
