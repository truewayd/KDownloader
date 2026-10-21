# Notification icons and delivery details

- Use five independent, project-drawn abstract indicators in native notifications and application toasts. Filled rounded color blocks, teal and pale tones, subtle gradients and soft shadows follow the original logo's visual language. Native download failures select error; waiting-for-engine notices select warning. Module update announcements use the speech-bubble shape.
- Simplify error and success to two blocks each, information to a pale dot and teal stem, and announcements to a rounded bubble with a pale tail. Warning retains only an open triangle, with the pale block on the left. Distinct silhouettes keep small toast icons recognizable without extra interior marks.

- Render the shared indicator SVGs at 256px and retain a bounded, reusable family in the profile cache. Windows and Linux select the appropriate indicator; sender registration retains the canonical TrueDown brand. macOS identifies the installed TrueDown bundle and attaches the business indicator.
- Windows notification activation opens the existing main window through its normal lifecycle coordinator. Keep the profile-specific notification identity, single tag/group, silent updates and shutdown guard.
- Mark an aggregate delivered only after the native sender accepts it. Failed attempts retain counts and retry after 30 seconds; repeated identical delivery errors do not flood logs. Linux discards failed notification handles so the next attempt can recreate them.
- Add success, error and information icons to application toasts through the shared component. Preserve literal, selectable text, long-message wrapping, native-titlebar placement and reduced-motion behavior. In-progress update messages use the information state.
- Require Go 1.26.10 for core and bundled module builds to include the crypto/x509 certificate distrust fix for GO-2026-6809; retain the dependency vulnerability audit in native validation.

## Verification

- Focused Rust notification regressions and desktop checks, shared component/icon synchronization and browser toast checks in light/dark themes at desktop and narrow widths.
- Go tests, vet and govulncheck with the patched Go 1.26.10 toolchain.
- Native notification appearance and activation on installed operating-system packages require separate verification.
