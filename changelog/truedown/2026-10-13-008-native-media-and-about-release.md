# TrueDown native media, link probing and About improvements

## Changes

- Add native NEXT 3 HLS/DASH downloads, including pause/resume, failed-transfer retry and live recording finalization. Older engines retain media tasks until a compatible engine is selected without blocking ordinary downloads.
- Add explicit link probing for filenames, sizes and resumability without creating tasks or rewriting drafts.
- Persist browser imports before acknowledging them, and improve NEXT 2/3 checkpoint, recovery and shutdown compatibility.
- Confirm actual native pause completion before reporting success, so immediate task or queue resume cannot overtake the engine's writer shutdown. Pause waits are bounded and cancelled on manager shutdown.
- Improve About version information, project reference spacing, source links and wrapping license labels while preserving full original notices.
- Keep select menus open after delayed focus-scroll events when their anchor has not moved. Actual scrolling still dismisses the menu without committing a choice.

## Verification

- NEXT 3.0.0 and 2.8.3 real-engine suites, Go test/vet and WSL Linux integration checks.
- Full JavaScript suite and Chromium select/form checks, including delayed scroll and actual anchor movement.
- About layout, keyboard access, source links and expanded license contents at 1040, 820 and 390 pixels in light and dark themes.
- Shared UI/icon verification, Python migration tests and clean extension packaging.
