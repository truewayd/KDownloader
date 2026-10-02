# TrueDown download workspace and native appearance

## Changes

- Add global BitTorrent User-Agent and Peer ID prefix settings for Aria2 Next 2.6.7+. Preserve partial updates, restore saved values at startup and keep HTTP identity independent.
- Keep virtual-list scroll height stable when selecting or clearing tasks.
- Add transparent teal illustrations to empty download and search/filter states, with generous spacing and responsive sizing.
- Unify Windows settings, new-download, task-detail and confirmation content with the native Mica backdrop while preserving solid accessibility fallbacks and control contrast.
- Enlarge desktop icon artwork within its canvas without changing the mark, and regenerate Windows ICO and macOS ICNS representations.

## Verification

- JavaScript suite: 384 passed, 1 skipped. Python migration suite: 13 passed.
- Shared UI and generated icons verified; full Go tests and vet passed.
- Native build, Clippy and 44 Rust/dependency tests passed.
- Windows hidden native acceptance passed for auxiliary windows, theme/material state, high contrast, reduced transparency, scaling, caption controls and lifecycle behavior.
- Responsive browser checks and auxiliary confirmation layout checks passed. Native frontend PNG hashes and all 17 executable icon frames were verified.
- Visible compositor appearance and Explorer icon-cache refresh are not established by hidden/browser checks. Remote tracker/peer identity acceptance remains outside local RPC verification.
