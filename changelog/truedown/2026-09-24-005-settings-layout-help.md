# Clearer settings layouts and searchable help

- Fix file-group labels and inputs being squeezed into nested columns. Keep group names, directories and suffixes aligned, with stacked fields in narrow windows.
- Give excluded suffix choices their own full-width grid, align setting switches and tray controls, and correct experimental range-field alignment.
- Show concise setting descriptions directly instead of expandable help. Search includes authored descriptions and range/suffix labels while excluding profile values and live status.
- Preserve the shared UI baseline, minimal borders and automatic saving.

## Verification

- Settings browser acceptance covers all eight categories in light/dark themes at 1040px, 820px and 390px, including group field geometry, search navigation, retained drafts and automatic saving.
- Node repository tests and shared UI mirror validation.
