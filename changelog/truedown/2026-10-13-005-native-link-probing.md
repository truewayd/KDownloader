# Native download preflight

- Add an explicit New download probe for one HTTP(S) link: display the native
  suggested name, response size, content type and resumability without creating
  a task or rewriting the draft. Media manifest size is not final video size.
- Delegate requests and response interpretation to NEXT's `aria2.probe`, with
  shared submission headers, referrer and proxy settings. Older engines report
  unsupported capability without starting a fallback transfer.
- Keep native access scoped to New download, bound outstanding probes across
  caller cancellation, and suppress raw engine error text. Editing, source
  replacement, hiding or closing invalidates pending results.

## Verification

- Real NEXT 3 metadata, redirects, Cookie/Authorization scope, empty/unknown
  lengths, HTTP errors, and absence of task or download-file side effects.
- API rejection and concurrency tests; Chromium form checks for literal
  metadata, preserved fields and stale-response cancellation.
- Real NEXT 2.8.3 keeps media waiting, completes ordinary HTTP, removes waiting
  tasks safely, and rejects probing without issuing a source request.
