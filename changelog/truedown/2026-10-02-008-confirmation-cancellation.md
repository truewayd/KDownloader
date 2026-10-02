# TrueDown confirmation cancellation

## Changes

- Resolve confirmation results before native popup teardown and run answer/cancel IPC asynchronously, avoiding synchronous self-destruction of a WebView.
- Treat settled or removed requests as cancellation/completion, never as initialization timeouts. Preserve genuine initialization failures.
- Apply the same result/teardown ordering to non-Windows native context menus.

## Verification

- Native timeout-state regression and Rust tests passed; JavaScript confirmation tests passed.
- Windows hidden native acceptance passed. Hidden acceptance does not exercise a visible modal cancellation.
