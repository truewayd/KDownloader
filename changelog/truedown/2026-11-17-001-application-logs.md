# Application log controls and file allocation

- Allow desktop application log enable, disable and clear requests through the shared API contract.
- Cover the controls in Go API/transport and native bridge regression tests.
- Correct the falloc label: Windows MinGW engines support NTFS allocation; explain truncation and filesystem limitations.
- Refresh log-copy test fixtures for the localized empty state.

## Verification

- Go API and protocol regressions pass, including enable/disable/clear transport requests.
- Native bridge regression added; local Rust execution requires an MSVC linker.
