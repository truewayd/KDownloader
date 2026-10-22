# Desktop build dependency security update

- Raise the minimum Tauri npm CLI from 2.12.0 to 2.12.4 and refresh its locked platform packages. Upstream 2.12.4 replaces the CLI's embedded ZIP dependency to address RUSTSEC-2026-0367, RUSTSEC-2026-0368 and RUSTSEC-2026-0369; npm audit alone does not scan that compiled Rust dependency graph.
- Retain the reviewed Rust source patches, Go 1.26.10 baseline, runtime dependencies, icon tooling and browser test baseline. No application permissions or stored-data formats change.

## Verification

- npm audit reports zero findings; the installed local CLI reports 2.12.4.
- Go module checksums and govulncheck pass with Go 1.26.10.
- RustSec scan reports no vulnerabilities in Cargo.lock. Three upstream maintenance warnings remain in the Linux zbus 5 notification/single-instance graph; these are documented in the dependency audit without advisory suppression.
- Local checks passed: 452 JavaScript tests (one platform skip), 58 Rust tests, formatting/Clippy, native desktop build, Go tests/vet, 13 Python migration tests, UI/icon synchronization and focused release/native contracts.
