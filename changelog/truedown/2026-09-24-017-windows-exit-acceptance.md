# TrueDown: native menus and reliable safe exit

- Retain native menu positioning, rounded framing, immediate dismissal and system-font rendering.
- Accelerate safe engine exit while preserving checkpoints, bounded fallback cleanup and NEXT 2.8.2 native HTTP resume state.
- Deliver the normal Windows interrupt with CTRL_BREAK_EVENT so inherited CTRL+C-ignore flags cannot silently turn graceful exit into a seven-second kill timeout. Keep the helper's handler alive until it exits.
- Gate Windows core acceptance on timely clean exit. Group-rename acceptance waits for the saved name and drained write queue rather than a potentially stale status message.
- Resolve strict Rust Clippy errors on Windows, Linux and macOS without disabling warnings.

## Verification

- An isolated Windows regression reproduces the inherited-ignore failure (7.10s, forced exit) before the fix and normal exit (1.03s, code 0) afterward.
- Stable aria2 and NEXT 2.8.2 active-download shutdown and exact resumed output pass with the new interrupt.
- Local Go tests/vet, native/release contracts, private transport timing (0.59-0.74s), and complete hidden Windows window/crash acceptance pass.
- Cross-platform and native CI rerun against this commit before publication.
