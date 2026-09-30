# TrueDown native dependency security

- Require Tauri 2.11.6 or newer and update the locked runtime to fix
  GHSA-w28w-mhc8-qvjv: channel response retrieval must belong to its WebView.
- Update the desktop build CLI from 2.11.4 to 2.12.0.
- Retain the four reviewed GTK3 and URLPattern source patches, their original
  versions, complete source hashes and native license inventory.

Upstream advisory:
https://github.com/tauri-apps/tauri/security/advisories/GHSA-w28w-mhc8-qvjv

## Verification

- Windows debug desktop and matching Go sidecars build with Tauri 2.11.6.
- All four native source patches pass full-tree hash verification; native
  license generation includes 284 Windows dependencies and their notices.
- Full Rust lockfile OSV review retains only the patched GLib advisory and alias.
- Rust formatting, strict Clippy, 44 Windows tests and hidden native acceptance
  pass. Linux optimized GLib and URLPattern regressions both pass.
- The locked Linux license inventory generates notices for 372 dependencies.
