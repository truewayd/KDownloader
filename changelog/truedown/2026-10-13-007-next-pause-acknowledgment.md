# TrueDown NEXT 3 downloads and pause synchronization

## Changes

- Wait for the download engine to finish pausing before acknowledging individual, batch or queue pauses. Immediate resume no longer fails while NEXT is still stopping its writer.
- Bound pause synchronization to five seconds and cancel it when the manager shuts down. Live media finalization uses the same settled pause contract.
- Include native NEXT 3 HLS/DASH downloads, explicit link metadata probing, durable browser imports and improved NEXT 2/3 recovery compatibility.
- Improve the About page's project references, source links, wrapping license labels and complete third-party notices.

## Verification

- Deterministic delayed-pause, terminal-state, timeout and lifecycle-cancellation checks.
- Real NEXT lifecycle and updater pause/resume checks, plus direct native-state assertions for single-task and whole-queue pauses.
- Full NEXT 3.0.0 and 2.8.3 acceptance, Go test/vet and WSL Linux integration checks passed locally.
