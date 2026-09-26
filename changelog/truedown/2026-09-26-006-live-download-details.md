# Live download information

- Rework the download-details window into compact information/settings tabs,
  byte/speed/time facts, overall progress, a completed-piece map and live connections.
- Read aria2 tellStatus/getServers only for the requested task with cancellation,
  a shared deadline, bounded concurrency and stale-task checks.
- Limit displayed piece ranges and connections, strip redirect credentials, and
  leave missing transfer/resume information explicitly unavailable.
- Keep task controls reachable, settings drafts intact and links selectable in a
  fixed 640px-wide native window.

Reference: https://aria2.github.io/manual/en/html/aria2c.html#aria2.tellStatus

## Verification

- Go transfer parsing, redaction, cancellation and stale-response tests.
- Task-detail browser acceptance at 640px and 520px in both color schemes.
