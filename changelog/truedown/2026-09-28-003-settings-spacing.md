# TrueDown settings spacing

- Remove nested padding from engine update and resolver module cards so their content aligns with other settings panels.
- Keep one 16px inset for standalone program-update panels, use 24px between sections and modules, and use 8px for related copy and actions.
- Group module help with its heading and remove the trailing gap after the last visible settings section.
- Collapse empty status hints and reset version/storage list margins so the update panel does not inherit blank grid rows or browser-default spacing.

## Verification

- Settings browser acceptance across light/dark themes and desktop/narrow widths, including content alignment, overflow and interactive state.
- Shared UI consistency and repository tests.
