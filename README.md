# KDownloader monorepo

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

<table>
  <tr>
    <td align="center" width="50%">
      <img src="icons/kdownloader-logo.svg" width="112" alt="KDownloader logo"><br>
      <strong>KDownloader</strong><br>
      Chrome MV3 creator-content toolkit
    </td>
    <td align="center" width="50%">
      <img src="truedown/web/truedown-logo.svg" width="112" alt="TrueDown logo"><br>
      <strong>TrueDown</strong><br>
      Standalone Windows download manager
    </td>
  </tr>
</table>

This repository hosts two independently developed and released projects. KDownloader lives at the repository root; TrueDown lives under `truedown/`.

## KDownloader

KDownloader is a dependency-free Chrome Manifest V3 extension for discovering, collecting, and downloading creator content.

### Highlights

- Adds shared post, creator, page, and favorites actions to Kemono, Coomer, Pawchive, and CoomerFans pages.
- Provides Creator Fetch modes for incremental downloads, full fetches, external-link exports, and Pawchive DM exports.
- Tracks download history in IndexedDB with paged export and chunked, duplicate-safe import.
- Watches Pawchive creators for updates and supports manual or scheduled checks.
- Dispatches to loopback-only AB-compatible or Gopeed backends, with an explicit Chrome-download fallback after total failure.
- Includes a Dropbox-expansion filter synchronized to TrueDown, external-link filtering, creator search caches, and optional GitHub Gist sync.
- Keeps backend and Gist secrets in local-only extension storage.

### Build and load

Requirements:

- Google Chrome or another Chromium browser with Manifest V3 support
- Node.js for tests
- PowerShell 7 for the clean build script

```powershell
npm test
npm run test:python
npm run build
```

The unpacked extension is written to `dist/KDownloader`. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select that directory.

### Configuration notes

- Advanced settings are available from the extension popup.
- Backend hosts are limited to `localhost` and `127.0.0.1`.
- API keys are optional unless the selected backend requires one.
- Restoring defaults preserves IndexedDB history and the Pawchive Watch list.
- The generated `dist/` directory is build output and should not be edited manually.

## TrueDown

<p align="center">
  <img src="truedown/web/truedown-logo.svg" width="96" alt="TrueDown logo">
</p>

TrueDown is a standalone Windows download manager written in Go. It embeds an aria2-powered queue and a responsive web dashboard in a single local service.

### Highlights

- Listens on `127.0.0.1:15151` by default.
- Provides an embedded dashboard for creating, filtering, paging, column sorting, pausing, resuming, retrying, opening, and removing tasks, including whole-queue controls.
- Lets users choose a persisted Dropbox shared-folder default—direct archive or bounded parallel expansion—while retaining per-submission overrides, optional filtering, and bulk task import.
- Ships Dropbox and Google Drive with embedded resolver-component baselines; each can be enabled independently or hot-updated from a bounded declarative package without replacing TrueDown.
- Keeps component protocol profiles under the TrueDown data directory, reports their version and SHA-256 digest, and can immediately restore the embedded baseline from the dashboard.
- Resolves public Google Drive files, large-file confirmation pages, recursive folders, and Docs/Sheets/Slides exports without a Google Developer API key.
- Persists the aria2 simultaneous-download limit, defaults it to 3, and applies changes immediately.
- Bounds queue admission, request sizes, batch operations, filenames, folders, headers, and aria2 options.
- Supports optional API Key authentication and requires authentication plus TLS for non-loopback listeners.
- Implements AB Download Manager's HTTP browser-integration fallback endpoints on the same listener.
- Persists task state in SQLite and keeps sensitive request headers out of dashboard snapshots.
- Removes active partial data only after aria2 confirms the task state; removing completed records preserves downloaded files.

### Build and run

Requirements:

- Windows
- Go 1.26.4 or a compatible newer toolchain
- `truedown/aria2/aria2c.exe`

```powershell
Set-Location truedown
go test ./...
go vet ./...
pwsh -NoProfile -ExecutionPolicy Bypass -File build.ps1
```

The Windows package is written to `truedown/dist/TrueDown`. Start `TrueDown.exe`, then open `http://127.0.0.1:15151`.

For a remote listener, configure a specific interface with `TRUEDOWN_ADDR`, opt in with `TRUEDOWN_ALLOW_REMOTE=1`, enable API Key authentication, and provide `TRUEDOWN_TLS_CERT` and `TRUEDOWN_TLS_KEY`. Wildcard binds are rejected.

## Repository map

```text
background/       KDownloader service worker and RPC handlers
content/          Site integration, shared content UI, and route watching
popup/            Daily-use extension popup
shared/           Extension-page UI primitives, i18n, and icon sprite
tests/            Node and Python tests
tools/            Extension build and release-note scripts
truedown/         TrueDown Go runtime, embedded dashboard, and build script
changelog/        Path-scoped release notes
```

## Full verification

```powershell
npm test
python -m unittest tests/migrate_history_json_test.py
pwsh -NoProfile -ExecutionPolicy Bypass -File tools/build-extension.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File tools/read-latest-changelog.ps1 -OutputFile release-notes.md

Set-Location truedown
go test ./...
go vet ./...
```

## Releases

KDownloader and TrueDown use path-scoped GitHub Actions workflows and independent version tags. A commit that changes both product paths can publish both releases.

## License

See [LICENSE](LICENSE).
