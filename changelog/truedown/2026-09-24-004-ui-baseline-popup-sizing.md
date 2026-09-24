# Unified desktop UI and compact independent prompts

- All TrueDown windows now share one neutral light/dark visual baseline, control typography and spacing. Page CSS owns layout; native appearance CSS owns frame/material integration.
- Settings uses a quiet 32px reset icon beside the scrolling category title. Main toolbars no longer add decorative divider lines.
- Confirmation purpose appears only in the native title. Windows confirmation captions omit icons; warning/error content keeps one severity icon. Information prompts have no decorative icon. Width is 440px and content determines a bounded 144–420px height; long descriptions scroll while actions stay visible.
- Menu window titles and popup failure messages use Chinese. Original popup failure diagnostics remain in the console. Visible concurrency-test captions are Chinese too.
- Intent-based, single-use popup preparation limits retained windows per caller/kind and expires unused windows after 60 seconds, preserving cancellation and unique request ownership.

## Verification

- Node suite: 366 passed, one skipped. Rust: 36 unit tests and one dependency regression passed; Clippy warnings denied.
- Settings, workspace, forms, auxiliary and context-menu browser acceptance covers light/dark, narrow layouts and keyboard behavior.
- Windows visible popup acceptance checks independent HWND ownership, parent modality, IPC restrictions, shared theme tokens and screenshots. Native editing copy/paste/cut/undo/redo/select-all acceptance passed.
- macOS and Linux native visual composition were not run in this Windows session.
