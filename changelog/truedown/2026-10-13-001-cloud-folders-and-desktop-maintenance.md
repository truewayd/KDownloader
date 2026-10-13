# TrueDown cloud folders and desktop maintenance

- Download public MEGA folders as a verified local ZIP or independent files with their hierarchy. Expanded MEGA, Dropbox and Google Drive files share the saved suffix filter, while direct files and archives retain their complete contents.
- Show complete dependency licenses and pinned protocol references in About, including the native dependency inventory included during packaging.
- Preserve tooltip sessions when Windows renews a native window, and wait for native composition before displaying a tooltip over the caption region.
- Consolidate repeated update-cleanup failures while retaining the regular retry schedule, changed files and durable cleanup receipts.
- Build the versioned MEGA baseline before clean-checkout Go and NEXT tests. Native packaging uses the same build entry point.
- Reuse completed private ciphertext members when resuming a folder with NEXT, which rejects re-admission of an existing file without its completed control file. ZIP publication still requires every member's MAC verification.
- Wait for native menu visibility before WebDriver transfers focus during Linux editing acceptance, preserving the caller's focus while the popup initializes.
- Keep an open context menu when WebKit reports an unchanged viewport. Actual viewport or display-scale changes still cancel the request and reject stale actions.

## Verification

- Node contracts: 410 passed, one existing skip. Python migration: 13 passed. Shared UI and icons checks and extension packaging passed.
- Full Go tests and vet, real aria2 artifact/collection pause-resume-removal tests, Rust formatting, 51 native unit tests plus one dependency test, and clippy passed locally.
- Tooltip browser checks passed at 100/125/150/200% scale. Settings and About passed six viewport/theme combinations.
- A clean source snapshot reproduced the missing bundled MEGA baseline. Preparing the baseline fixed the same test in that snapshot.
- The NEXT 2.8.3 folder-resume failure was reproduced locally. The corrected regression passed with both engines, and the complete NEXT downloader suite passed with Go 1.26.9.
- Linux WebKit's intermittent first-menu cancellation was reproduced in WSL with the published native bundle: a delayed, unchanged resize cancelled the request before selection. Browser regressions cover duplicate resize notifications, actual viewport changes and display-scale changes.
- Visible inactive-window compositor acceptance and external public-cloud fixtures were not rerun for this commit batch; browser/native unit checks do not establish those outcomes.
