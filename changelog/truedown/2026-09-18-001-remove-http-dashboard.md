# TrueDown 2.0.0: desktop interface and API-only HTTP service

- Remove the HTTP dashboard and embedded frontend assets from the core. The
  default 127.0.0.1:15151 listener keeps the CLI and extension APIs; webpage and
  static asset requests return 404.
- Keep the Tauri bundled interface and private IPC transport. Remove browser
  login prompts, frontend API Key storage, and browser session cookie issuance
  and authentication. Existing browser sessions no longer authorize API calls.
- API Key defaults, header authentication, remote TLS requirements, task data,
  and download behavior are unchanged. Use the desktop interface or CLI in
  place of the removed browser dashboard.
- Browser layout fixtures supply their own test transport. Add regression
  coverage for retired web routes, legacy cookie rejection, and retained native
  and authenticated HTTP operations.

This is a breaking removal of the browser interface; HTTP integration routes
and protocol version 1 remain compatible.

## Verification

- Go regressions cover header authentication, rejection of old browser cookies,
  retired frontend routes, CLI requests, and private desktop transport.
- Frontend tests cover native read deadlines and refusal to fall back to HTTP.
- Core smoke fixtures check actual HTTP 404 responses and retained native/API
  access before and after enabling authentication.

Passed checks:

- `npm run ui:check`, `node --test --test-reporter=dot tests/*.test.mjs`,
  `py -m unittest tests/migrate_history_json_test.py`, and the extension build.
- `go test ./...` and `go vet ./...` from `truedown`.
- WSL test binaries, aria2 integration tests, and `tools/smoke-linux.sh`.
- `npm run build -- --debug --no-bundle` and `npm run test:windows` from
  `truedown/desktop`; all native acceptance windows stayed hidden.
- `node tools/smoke-desktop.mjs desktop/target/debug/truedown-core.exe desktop/target/debug/truedown-cli.exe`
  from `truedown`, including CLI status with authentication off and on.
- Desktop layout fixtures for workspace, settings, auxiliary controls, task
  forms, and file groups. The file-group fixture waits for the return request
  before checking its validator.
