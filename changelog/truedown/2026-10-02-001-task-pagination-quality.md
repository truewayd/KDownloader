# Task pagination reuse and bounded working memory

- Reuse the existing ordered task IDs for default and ID-sorted file-group
  pages. Count all matches while retaining only the requested page instead of
  allocating and sorting every matching ID.
- Share explicit task sorting between ordinary and file-group pages. The
  existing unique ID tie-breaker preserves deterministic order without a
  stable sort. Reuse default-page traversal and the already computed validator.
- Remove the unreferenced Google Drive export and Dropbox metadata wrappers
  after checking runtime, test and build references.

## Verification

- Regression matrix covers seven sort fields, both directions, status/search
  filters, ties, page boundaries, absent groups and conditional responses.
- Windows `go test ./...` and `go vet ./...`; WSL Linux package/integration tests
  and core HTTP smoke test.
- `BenchmarkCategoryPage100Of10000`, three runs per variant: default/ID pages
  decrease from approximately 385 KB and 44 allocations to 27 KB and 21
  allocations per operation (100 returned tasks). These are local synthetic
  measurements, not native UI or end-to-end download acceptance.
- No HTTP, native IPC or durable storage format changes.
