# TrueDown update proxy settings

- Centralize proxy mode validation, system lookup and loopback bypass in
  `truedown/internal/netproxy`; network callers only adapt its selected route.
- Apply the saved system, custom HTTP(S), or no-proxy choice to TrueDown/NEXT
  update checks and assets, executable-module metadata/signatures/downloads,
  cloud resolver defaults and tracker upstream requests.
- Read saved choices for each operational request and reapply the current proxy
  when updater-owned downloads enter or re-enter the queue, including individual
  and whole-queue resume. Failed proxy refresh keeps the update paused.
- Keep local update relays and core/engine RPC direct. Update requests inherit
  only the proxy choice, preserving their own headers and validation rules.
- Ordinary downloads without explicit proxy options and MEGA preparation/member
  transfers share the saved proxy choice while retaining task parameters and
  explicit proxy overrides. Module processes reuse the canonical policy and
  transport factory for their parent-selected route.

## Verification

- Offline HTTP and HTTPS proxy fixtures cover saved mode changes, direct local
  traffic, update metadata/assets and downloader admission without credential
  leakage into operational requests or public snapshots.
- Individual and queue resume fixtures reject proxy-refresh failures before
  restarting transfers. Ordinary-task fixtures preserve explicit proxy options,
  task credentials and numeric parameters.
- Full Windows Go tests and Go vet, WSL/Linux tests and core startup checks pass.
- Go 1.26.9 (the CI baseline) passes Go module verification and govulncheck;
  the desktop npm dependency audit reports no vulnerabilities.
- Native aria2 1.37.0 and NEXT 2.8.3 complete proxied ordinary/update transfers
  while keeping local update traffic direct. Full integration suites pass.
- The local Windows dev package builds and passes hidden shell/core/CLI startup
  and graceful-exit checks. Remote platform/package validation is recorded by CI.
- Shared UI check, JavaScript suite (425 passed, one skipped), Python migration
  tests and the extension build pass.
