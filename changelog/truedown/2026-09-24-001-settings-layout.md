# Quieter settings layout

- Flatten settings into a single content surface with clearer group spacing and labels beside their controls. Narrow windows stack controls and wrap extension selections.
- Place a compact, accessible reset icon beside the category title, retaining confirmation and category-scoped persistence.
- Scroll the title with its settings instead of reserving a fixed header. Category navigation returns to the top while refreshes preserve the current position.
- Keep existing sidebar icons, automatic saves, search highlighting, and light/dark appearance.
- Product confirmations now use the shared project dialog in desktop windows as well as browser views. Explicit OS integration confirmations retain the bounded native command and fail-closed behavior.
- Document the dialog policy and native versus themed context-menu implementation options.

## Verification

- Settings browser acceptance in light/dark themes at 1040, 820, and 390 pixels, including all categories, overflow, keyboard interaction, save failures, and reset cancellation.
- Frontend unit tests and shared component mirror check.
