# Dependency audit - 2026-10-22

The extension has no third-party runtime dependencies. This audit covers the
desktop npm lockfile, the TrueDown Go module and the complete desktop Cargo
lockfile, including platform-specific dependencies and reviewed local patches.

## Repair

Update `@tauri-apps/cli` from 2.12.0 to 2.12.4 in the manifest and lockfile,
including its optional platform binaries. The upstream CLI release replaces
its embedded ZIP implementation to fix RUSTSEC-2026-0367, RUSTSEC-2026-0368
and RUSTSEC-2026-0369. These compiled dependencies are outside npm audit's
coverage. The local CLI executable reports 2.12.4 after installation.

Source: [Tauri CLI 2.12.4 release](https://github.com/tauri-apps/tauri/releases/tag/%40tauri-apps%2Fcli-v2.12.4).

The first Linux native CI run failed in npm's audit service after a five-minute
request fell back to the retired quick-audit endpoint (HTTP 400). The same
lockfile installed with zero audit findings, and the other native jobs passed
the audit. Native CI now bounds audit requests to 30 seconds with one fetch
retry and retries structured registry errors up to three audit attempts.
Reports containing advisory findings, malformed reports and exhausted retries
fail the job. The low-severity threshold and Go audit gates remain mandatory.

## Security evidence

- Desktop npm audit: zero findings before and after the update.
- Go 1.26.10: `go mod verify` passes and govulncheck 1.8.0 reports
  `No vulnerabilities found.`
- cargo-audit 0.22.2: zero vulnerabilities in the Cargo lockfile, with the
  RustSec database at `4b587f00996ebe5c05a73eaef105ef241e876414`
  (2026-10-21). Three maintenance warnings remain, listed below.
- `verify-native-patches.mjs` verifies all four reviewed local source trees.
  Local compatibility fixes and their recorded file hashes are preserved.

The Windows cargo-audit executable was unavailable in the existing tool
locations, so the official 0.22.2 binary was installed for reuse under
`C:/Users/leisu/.codex/tools/cargo-audit/0.22.2`. Its downloaded archive
matched the upstream release SHA-256
`0a7316540862c13d954f648917ceacca593747baed6eec180fafa590be2710ab`.
Existing Node 22.22.2, Rust 1.98.1, cached Go 1.26.10 and build/dependency
caches were reused; no global toolchain configuration changed.

## Upstream maintenance limitations

| Crate | Locked version | Advisory |
| --- | --- | --- |
| zvariant | 5.15.0 | RUSTSEC-2026-0370 |
| zbus_names | 4.3.4 | RUSTSEC-2026-0371 |
| zvariant_derive | 5.15.0 | RUSTSEC-2026-0372 |

These crates moved into zbus 6. The current Linux graph still requires zbus
5.19.0 through notify-rust 4.18.2 and tauri-plugin-single-instance 2.4.4.
notify-rust 4.18.2 is the latest available release at audit time. A direct
zbus 6 dependency would not replace those transitive requirements. Retain
the compatible graph until the calling dependencies migrate; do not hide
these notices or describe this result as zero warnings.

Sources: [zvariant](https://rustsec.org/advisories/RUSTSEC-2026-0370.html),
[zbus_names](https://rustsec.org/advisories/RUSTSEC-2026-0371.html),
[zvariant_derive](https://rustsec.org/advisories/RUSTSEC-2026-0372.html).

## Other available versions

Newer Playwright, Lucide, SQLite, Go modules and Tauri runtime versions are
available. Being older is not itself a vulnerability finding. This repair
does not expand into an unrelated browser baseline, generated icon refresh,
database engine change or native-window framework migration. Keep their
current lockfiles and deliberate compatibility pins.

## Verification boundaries

Local verification passed with 452 JavaScript tests and one platform skip,
58 Rust tests, Rust formatting and Clippy, Go tests/vet, 13 Python migration
tests, the native Windows debug build, UI/icon synchronization and focused
release/native contracts. The updated CLI prepared the existing 284-entry
native license inventory successfully.

Local audit output and build/test logs are retained in
`work/runs/20261022T065536Z-dependency-maintenance/` with a lifecycle manifest
and a 14-day expiration. Build and release CI provide separate evidence for
Windows, Linux and macOS. Automated checks do not establish installed-OS
visual acceptance or live-site download acceptance.
