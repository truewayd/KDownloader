# TrueDown UI lifecycle and update performance

- Coalesce tooltip geometry reads during progress bursts into one animation frame; retain caption composition readiness, delayed dismissal and failure recovery.
- Close custom select pickers when their anchor is removed, hidden or disabled through a parent fieldset, without committing a selection.
- Flatten settings groups into the existing working surface, using headings and spacing instead of nested outlines and extra narrow-layout indentation. Fieldset semantics and disabled behavior remain intact.
- Bind task-page ETags to their matching response body. A new response without an ETag no longer inherits an old validator; unchanged 304 responses reuse the retained serialized size.

## Verification

Node regressions, Go tests/vet, Linux package tests and core smoke, task-page benchmarks, browser checks with 2,400 tasks, both color schemes, narrow layouts, settings interactions and 100/125/150/200% tooltip scaling. Browser transports and caption IPC are fixtures; these checks do not certify visible native composition or release packages.
