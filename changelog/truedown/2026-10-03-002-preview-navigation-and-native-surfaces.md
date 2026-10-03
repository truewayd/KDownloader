# TrueDown preview navigation and native surfaces

## Changes

- Add consistent preview toolbar icons for image zoom, fit, text wrapping and file actions, with accessible names, shared tooltips and compact controls in narrow windows.
- Zoom images with the ordinary mouse wheel around the pointer, pan enlarged images by dragging, and use +/-, 0 and F for zoom, actual size and fit. Keep text/media wheel behavior unchanged and image zoom bounded to 5%-800%.
- Restore the last audible volume after a quick slider drag to zero, without relying on delayed media events.
- Restore native minimize/maximize/close hover backgrounds by limiting custom-frame glass extension to the caption. Keep Windows Snap Layouts and native controls.
- Apply continuous Mica only to information/warning/danger confirmations; restore opaque Settings, New task and Task details content. Permit only the confirmation's own material update through its restricted IPC gate.

## Verification

- Repository Node tests: 388 passed, 1 skipped.
- Preview browser regression passed: pointer-anchored wheel zoom, pixel/line/page wheel modes, drag panning, scale bounds, keyboard controls, icons and accessible labels, text scrolling, custom media controls, responsive layout and existing preview security checks.
- Icon generation check and shared component mirror check passed. Light/narrow preview screenshots were inspected.
- Cargo: 47 unit tests and 1 dependency regression passed; strict Clippy and Rust formatting checks passed. Corrected the assertion formatting caught by the initial CI run.
- Final Windows hidden native regression passed: preview permissions/reopen, form and settings state, native materials, accessibility fallbacks, scaling, recovery and process cleanup.
- Package startup/identity/hidden-window/exit checks passed locally. The visibility probe permits one retry only after a terminated 30-second deadline; regression tests retain failure on repeat timeouts, invalid output, process exit and other errors.
- Native hover recovery and confirmation appearance were reviewed by the user. Automated visible acceptance was not run.
