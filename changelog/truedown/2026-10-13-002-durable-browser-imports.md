# Durable browser imports

- Acknowledge ABDM browser requests after committing a bounded local inbox;
  slow cloud resolution no longer waits inside the browser's 500ms request.
- Preserve silent-add pause intent, pending request deduplication and restart
  replay. Existing completed tasks are not restarted by replay.
- Keep credentials private and report post-acceptance resolution failures
  through download-issue notifications. Queue/storage failures never return OK.

## Verification

- Go/API tests, slow resolver acknowledgement, cancellation/restart, cursor
  persistence, duplicate identity, queue capacity and storage failure tests.
