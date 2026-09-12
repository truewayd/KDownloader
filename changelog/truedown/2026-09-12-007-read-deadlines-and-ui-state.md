# TrueDown - Read deadlines and consistent UI state

- Apply the GET deadline alongside caller cancellation for both HTTP and native
  requests. Reuse this transport behavior for application logs.
- Capture settings values and their revision before awaiting earlier saves,
  preventing older values from overwriting concurrent defaults changes.
- Restore the original task button's keyboard focus after returning from task
  details, including unchanged 200 and 304 responses. Later polling preserves
  focus the user has moved elsewhere.

## Verification

Focused Node regressions and all five browser acceptance suites
pass, including narrow layouts, light/dark themes, 200% scale, retained drafts,
and real keyboard-focus behavior.
