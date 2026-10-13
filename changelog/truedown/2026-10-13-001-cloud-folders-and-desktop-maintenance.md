# TrueDown cloud folders and desktop maintenance

- Download public MEGA folders as a verified local ZIP or independent files with their hierarchy. Expanded MEGA, Dropbox and Google Drive files share the saved suffix filter, while direct files and archives retain their complete contents.
- Show complete dependency licenses and pinned protocol references in About, including the native dependency inventory included during packaging.
- Preserve tooltip sessions when Windows renews a native window, and wait for native composition before displaying a tooltip over the caption region.
- Consolidate repeated update-cleanup failures while retaining the regular retry schedule, changed files and durable cleanup receipts.
- Build the versioned MEGA baseline before clean-checkout Go and NEXT tests. Native packaging uses the same build entry point.

## Verification

- Node contracts: 409 passed, one existing skip. Python migration: 13 passed. Shared UI and icons checks and extension packaging passed.
- Full Go tests and vet, real aria2 artifact/collection pause-resume-removal tests, Rust formatting, 51 native unit tests plus one dependency test, and clippy passed locally.
- Tooltip browser checks passed at 100/125/150/200% scale. Settings and About passed six viewport/theme combinations.
- A clean source snapshot reproduced the missing bundled MEGA baseline. Preparing the baseline fixed the same test in that snapshot.
- Visible inactive-window compositor acceptance and external public-cloud fixtures were not rerun for this commit batch; browser/native unit checks do not establish those outcomes.
