# Independent MediaFire HTTP resolver

MediaFire public file links, legacy `/?quickkey` links and public folder links
are handled by `modules/mediafire`, a separately compiled pure-Go executable.
No Rust, Python, Java, browser automation or curl runtime is added. The MIT
projects md_api and md_downloader are protocol/behavior references; their pinned
original notices are included in About and the module release.

## Ownership and protocol

The module imports the private `modulehost` protocol and shared proxy transport,
never the downloader manager, SQLite store or desktop shell. It cannot choose a
local output path. It reads public metadata/pages only; aria2 owns file payloads,
connections, rate limits, resume and retry. No browser cookies or site headers
are passed into it. Parent-selected proxy credentials travel only over private
stdin and are not included in public errors or task snapshots.

The length-prefixed protocol remains version 1, with bounded JSON, a per-process
nonce, increasing request IDs and cancellation on parent EOF. Required handshake
capabilities are `http-resolver-v1` and `public-folder-v1`; MEGA's artifact
capability cannot substitute for either.

| Method | Request | Result |
| --- | --- | --- |
| resolve | source | canonical source and folder boolean; no network access |
| list | source, proxy, offset, limit (1–100) | name, entries, total, next; -1 terminates |
| prepare | source, proxy | filename, byte size, transient HTTPS URL, optional SHA-256 |

Single files are durably admitted before network preparation, including paused
tasks. Source aliases normalize to the same task identity. A resumed/retried
task calls prepare again; temporary URLs are never the durable source. The host
compares the persisted remote name, size and available digest before reusing a
partial transfer. Local caller-supplied names remain independent. The API digest
is an identity guard; it does not turn an ordinary HTTP download into MEGA's
verified artifact-publication contract.

The module reads MediaFire API 1.5 `file/get_info`, `folder/get_info` and separate
`folder/get_content` files/folders pages. It advances every chunk, bounds nesting
to 64 components, files to 5,000, folders to 1,000, responses to 2 MiB and the full
IPC collection to 768 KiB. Duplicate keys, cycles, missing/nonadvancing cursors,
unsafe components and case-insensitive path collisions fail the whole listing.
Only a completely validated snapshot can reach host batch admission. Expanded
files use TrueDown's current shared folder filter and normal file-group rules;
direct files bypass the folder filter. Empty directory entries are validated but
do not create filesystem directories on their own.

Download buttons support quoted/reordered attributes, HTML entities and the
base64 `data-scrambled-url` form. No JavaScript is executed. The module stops on a
redirect to a CDN without downloading its payload. Both process and host allow
only HTTPS `download<number>.mediafire.com` / `download<number>.mediafirecdn.com`
transfers, without userinfo or ports. Password/login/captcha/WAF pages, private
or deleted links and unknown page formats fail explicitly; they need manual
browser handling. There is no password/captcha bypass or fallback HTML download.

## Independent installation and updates

The host embeds baseline `0.1.0`; `node tools/prepare-download-modules.mjs` builds
MEGA and MediaFire using the existing Go toolchain and target. MediaFire fixes
can subsequently ship without rebuilding the application:

1. Commit the provider changes and run its tests.
2. Push `truedown-module-mediafire-v<semver>` or dispatch
   `publish-mediafire-module.yml` with that version.
3. The workflow builds Windows amd64, Linux amd64/arm64 and macOS arm64 binaries,
   signs each manifest with the existing publisher key and publishes an immutable
   release containing 12 binary/manifest/signature files plus four license files.
4. The settings card checks this independent release stream. The host verifies
   Ed25519, module/platform/protocol/version, size and hash before install, then
   verifies the executable handshake before atomically selecting it.

Unsigned JSON profiles cannot change this executable. Activation failure keeps
the previous selection; baseline restore and invalid-update fallback use the
bundled binary. Active calls keep their captured executable path. Startup cleanup
retains current/previous versions and the bundled digest; runtime cleanup does
not prune executable paths. No signing private key belongs in the repository.

The KDownloader v1 capability/resolve API advertises `mediafire`; its opt-in
resolver dispatches public links without site credentials. An accepted file is
queued, not already resolved or downloaded. Later failures reach the existing
bounded download-issue notification path.

## Verification

Run from `truedown/` after preparing bundled modules:

```text
go test ./internal/modulehost ./modules/mediafire/... ./internal/downloader ./internal/api
```

Offline fixtures cover source aliases, HTML formats, missing buttons, private
files, response bounds, forbidden redirects, pagination, cycles/collisions,
atomic filtered admission, initial pause, changed identity, signed installation,
wrong capability activation and baseline startup. Browser tests cover the
MediaFire settings card and update action; extension tests verify no credential
forwarding and manual handling on failure.

Opt-in `TRUEDOWN_TEST_MEDIAFIRE_FILE` / `TRUEDOWN_TEST_MEDIAFIRE_FOLDER` run public
metadata smoke tests using the host system proxy policy. Setting
`TRUEDOWN_MEDIAFIRE_DOWNLOAD_SMOKE=1` enables a 233,373-byte public MediaFire press
document transfer through a real aria2 process, with a pinned SHA-256 check.
`TRUEDOWN_ARIA2_PATH` selects the engine. These live checks require network access;
offline success alone is not proof that a current public link is accessible.
Production signed-release delivery additionally requires the configured publisher
secret and a published version; local test keys do not establish that acceptance.
The release workflow installs its signed Linux package against the production
trust root before publishing. After publication it runs
`TRUEDOWN_TEST_PUBLISHED_MEDIAFIRE_VERSION=<version>` with
`go test ./internal/downloader -run '^TestPublishedMediaFireUpdate$'` to exercise
anonymous release discovery, real aria2 transfer, signature verification,
activation, persisted selection across restart and bundled baseline restore.
The first independent update must be newer than the embedded baseline (`0.1.0`).
Missing or mismatched `TRUEDOWN_MODULE_SIGNING_KEY` fails publication; the signing
utility verifies the configured key against `internal/modulehost/trust.go`.
Reruns may resume a draft only at the same source commit; existing public assets
must match byte for byte and are never overwritten.
