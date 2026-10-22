# Desktop build dependency security update

- Raise the minimum Tauri npm CLI from 2.12.0 to 2.12.4 and refresh its locked platform packages. Upstream 2.12.4 replaces the CLI's embedded ZIP dependency to address RUSTSEC-2026-0367, RUSTSEC-2026-0368 and RUSTSEC-2026-0369; npm audit alone does not scan that compiled Rust dependency graph.
- Retain the reviewed Rust source patches, Go 1.26.10 baseline, runtime dependencies, icon tooling and browser test baseline. No application permissions or stored-data formats change.
- Bound npm audit registry requests and retry API errors up to three attempts in native CI. Advisory findings and malformed reports still fail immediately; exhausted registry retries also fail. Retain the low-severity audit threshold and the subsequent Go checksum/security gates.
- Pin the native CI audit client to npm 11.19.0, compatible with Node 22, to remove npm 10's fallback to the retired quick-audit endpoint. Installation omits its own redundant audit; the dedicated mandatory audit retains the existing threshold.
- Reuse the artifact integrity test's module executable across its sequential pause, corruption and output-collision cases. Keep separate task/staging directories, the existing completion deadline and all integrity/non-overwrite assertions.

## Verification

- npm audit reports zero findings; the installed local CLI reports 2.12.4.
- Go module checksums and govulncheck pass with Go 1.26.10.
- RustSec scan reports no vulnerabilities in Cargo.lock. Three upstream maintenance warnings remain in the Linux zbus 5 notification/single-instance graph; these are documented in the dependency audit without advisory suppression.
- Local checks passed: 452 JavaScript tests (one platform skip), 58 Rust tests, formatting/Clippy, native desktop build, Go tests/vet, 13 Python migration tests, UI/icon synchronization and focused release/native contracts.
- Audit-loop fixtures verify clean success, immediate advisory failure, registry recovery, exhausted retries and malformed-report failure against the workflow's actual shell block.
- The artifact pause/integrity/collision regression passed 20 consecutive repetitions after fixture reuse; the downloader package suite and release workflow contracts also passed.
