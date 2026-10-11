# TrueDown integration, modules and update maintenance

- Accept opt-in KDownloader Dropbox/Google Drive resolution through a separate authenticated integration contract and report aggregated download issues through native notifications.
- Add an independently built Go MEGA public-file module: aria2 handles transfer/resume, while the module verifies and decrypts before publishing completed files. Bundle the baseline and verify signed module updates before activation.
- Reclaim updater-owned packages, expired staging/helpers and superseded engine/module versions while preserving active work and rollback versions. Never clean ordinary user downloads or their resume data.
- Normalize security test fixture roots before intentional alias checks so macOS system temporary-directory aliases cannot mask failures.
- Include checksum-pinned upstream license texts omitted by the macOS notification crate so native packaging retains complete notices.

## Verification

- Windows Go tests/vet, Rust formatting/tests/Clippy, extension contracts, and responsive settings browser checks; Linux integration/core smoke.
- Main-branch native/package workflows provide platform release validation. Independent signed module publication requires its separately configured publisher secret and versioned release; public folders and CloudRAID remain unsupported.
