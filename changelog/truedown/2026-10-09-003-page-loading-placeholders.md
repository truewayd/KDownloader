# Page loading placeholders

- Derive field and task-list loading placeholders from one shared component, with reduced-motion support. Settings categories, new-download defaults and task details wait for their first reads; the task list no longer shows an empty state before its first response.
- Wait for About information before revealing the category. Keep loaded content and drafts visible during background refreshes.
- Keep loading effects inside page content; native window transitions remain OS-owned.

## Verification

- Browser regression coverage includes slow reads, failures, drafts, responsive layouts and reduced motion.
- Native macOS and Linux package acceptance requires matching platform runners.
