# NEXT 3 and browser integration compatibility

- Recognize both NEXT version banners, discover filename resolution through
  RPC methods, and use the NEXT 3 unified checkpoint interval.
- Reject retired custom task options rather than silently ignoring them.
- Use graceful RPC shutdown for NEXT 3 on Windows and forbid unverified file
  prefix adoption. Keep checkpoint loading and validation inside the engine.
- NEXT 3 HTTP failure retries explicitly restart from zero because removing a
  stopped result discards its checkpoint and this release has no HTTP retry RPC.
  Native pause/resume and process-restart resume retain their checkpoints.
- Delegate explicit restart truncation and native state retirement to the engine;
  preserve a task record when engine cleanup fails. Completed outputs are kept.
- Acknowledge browser imports after a bounded durable inbox commit. Resolve slow
  cloud links in the manager lifetime, preserve silent-add pause intent and
  replay unfinished imports after restart. Replays do not restart completed tasks.
- Pin real engine acceptance to the official NEXT 3.0.0 binary, with a separate
  selectable NEXT 2.8.3 regression lane and executable identity verification.

## Verification

- Browser inbox persistence, cancellation, replay, capacity and pause tests.
- Real NEXT 3.0.0 identity, filename resolution, checkpoint settings, graceful
  shutdown, native restart resume, repeated retries and final file hashes.
- Go tests and vet, extension regressions, Linux tests and service smoke.
