# TrueDown caption hover and confirmation materials

## Changes

- Restore caption-height DWM frame extension for custom-framed work windows. The full-client glass extension introduced in `8be6acb` suppressed native caption-button hover backgrounds; the user confirmed all three buttons recover with the bounded extension.
- Keep full-client Mica for standard-caption information, warning and danger confirmations. Allow their caller-bound `apply_material` command through the popup IPC gate; previously that request was rejected and the page silently used its solid fallback.
- Restore opaque content and footer surfaces in Settings, New task and Task details while keeping native outer chrome.
- Add confirmation command-boundary coverage and real-popup material assertions, since browser material mocks cannot detect native IPC rejection.

## Verification

- Cargo: 47 unit tests and 1 dependency regression passed.
- `npm run ui:check` and `npm run test:auxiliary` passed.
- Windows hidden native regression passed, including material surfaces, light/dark themes, forced colors, reduced transparency, auxiliary windows and process cleanup.
- The user verified minimize/maximize/close hover backgrounds after the frame correction; Windows Snap Layouts also appeared before the correction.
- The user reviewed the updated isolated application and reported the confirmation material issue also appeared resolved. Automated visible acceptance was not run.
