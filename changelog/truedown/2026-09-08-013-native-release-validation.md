# Native release verification and Windows appearance

The Tauri shell now rechecks shutdown after a queued connection obtains the
session lock, preventing it from starting a new core during exit. Its bridge
reuses the compiled route table, serializes requests without an intermediate
JSON tree, and releases payload buffers as soon as the pipe write finishes.

Release validation streams package hashes while retaining bounded executable
headers. It verifies complete macOS notice digests and rejects duplicate update
manifest fields and incorrect JSON types. Package smoke coverage checks both
standalone and native core/CLI identities, console login-startup capability,
early process failures, and bounded diagnostics and cleanup.

Windows Mica and caption colors follow the effective light/dark page theme.
Material changes serialize and coalesce rapid theme and accessibility updates.
The top bar, navigation and narrow outer inset expose native Mica while task,
settings, logs and about content retain readable working surfaces and the
TrueDown accent. System caption controls remain available; reduced transparency
and high contrast use solid surfaces.

## Verification

The 17 release-validator tests, 282 Node regressions, 13 history migration tests,
component synchronization and extension build passed. Windows and Linux Go
tests/vet passed, including Linux aria2 integration. Rust tests (10 Windows,
9 Linux), formatting and Clippy with warnings denied passed.

Windows hidden native acceptance verified all four windows, retained drafts,
core recovery and shell/engine cleanup. DWM measurements matched light/dark
WebView themes, Mica state and solid accessibility fallbacks; screenshots and
computed styles verified opaque working surfaces and transparent outer chrome.
The final Windows release build passed icon/DPI/subsystem checks, hidden package
startup, shell/core/CLI identity checks, graceful exit, archive validation and
PowerShell-generated schema-2 file/archive hash verification.
Linux native WebKit window acceptance and the final numbered package startup,
CLI identity and archive validation passed under Xvfb.

The validator used approximately 5.3 MiB peak Python-traced memory for a 35 MiB
Windows archive. Both macOS architectures generated complete pinned notices
offline (278 dependencies each). macOS signing/runtime and Linux arm64 native
acceptance require their matching CI hosts; local archive fixtures cover all
five platform package contracts.
