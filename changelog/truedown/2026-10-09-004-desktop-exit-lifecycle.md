# Desktop exit lifecycle

- Route tray, native commands, system exit and clean core exit through one coordinator. Hide windows before core cleanup so ordinary exit does not display a connection failure.
- Keep repeated exit requests from bypassing cleanup and prevent reopening during shutdown.
- An owned core notifies the shell before explicit API exit or update restart; unexpected failures retain recovery behavior.
- This release also restores ordinary hidden main windows through retained-WebView native shell renewal, preserves native window capabilities, and avoids redundant geometry/material writes.
- Shared loading placeholders cover initial task lists, settings, task details and new-download defaults, including reduced motion and About readiness.

## Verification

- Native lifecycle tests cover repeated exit while cleanup is pending.
- Hidden Windows acceptance covers core recovery, external API exit and process cleanup; Unix native acceptance requires matching runners.
- Private-pipe smoke verified attached-service preservation and early stopping notifications before HTTP/pipe exit cleanup. Full Go tests/vet, 50 Rust tests and 401 passing Node tests (one skipped) passed locally.
