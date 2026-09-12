# TrueDown - Explicit authentication changes

- Reject authentication setting requests with an omitted, null, or mistyped
  `enabled` field before changing authentication or session cookies.
- Preserve explicit enable/disable behavior and externally managed settings.

## Verification

API regressions cover invalid fields with both ordinary and
externally managed authentication; the Windows Go suite passes.
