# aria2 NEXT compatibility audit

Reviewed on 2026-10-02 against the latest published release,
[v2.8.3](https://github.com/AnInsomniacy/aria2-next/releases/tag/v2.8.3),
published 2026-09-28. Changes were checked against the
[2.8.2 to 2.8.3 comparison](https://github.com/AnInsomniacy/aria2-next/compare/v2.8.2...v2.8.3).
Unreleased main-branch behavior is not treated as a release contract.

| Surface | TrueDown adaptation |
| --- | --- |
| Native HTTP recovery | Preserve GID for same-URL retries and process restarts. Keep the profile state directory. Never infer completion from file size. |
| Missing/incompatible recovery state | Native error 13 leaves output intact and offers an explicit clean retry. Existing range-error cleanup also remains bounded to the owned output. |
| Output collisions | Continue reserving payload/control-file pairs, pinning `out` and disabling automatic renaming and overwrite. Completed-file conditional refresh remains separate. |
| Dropbox / Google Drive | Recognize native partials without `.aria2`. A renewed source URL cannot inherit another URL's checkpoint; restart after metadata checks. Refreshed transient Google URLs remain engine-validated and may require a clean retry. |
| Filename RPC | Discover `filename-resolution` in `aria2.getVersion().downloadFeatures`. Send the original Content-Disposition as integer bytes, not a JSON string or Base64. Bound URL/header lengths to 16384/8192 bytes and use a one-second deadline. |
| Filename callers | Use the optional RPC for resolver metadata, with local-parser fallback. Caller-provided output names and existing output reservations stay authoritative. Ordinary unnamed HTTP tasks keep their URL-derived names. |
| Update discovery | Published Windows asset and checksum names are unchanged; automatic latest-release discovery, executable checks and SHA-256 validation need no format migration. |
| BitTorrent identity | Align the previously missed 2.6.7 global `bt-user-agent` and `bt-peer-id-prefix` options. Persist, hot-apply and restore through runtime settings; gate engine arguments and RPC options to NEXT 2.6.7+. Keep HTTP identity independent. |
| Diagnostics / native IPC / browser API | No new native commands or supported URL protocols. The existing runtime-settings endpoint accepts optional `btUserAgent` and `btPeerIdPrefix`; partial updates preserve omitted fields. |

The filename method is local computation: no remote request and no download
task. The wire format and advertised feature were checked in the released
[SessionMethods.cc](https://github.com/AnInsomniacy/aria2-next/blob/v2.8.3/src/rpc/SessionMethods.cc).
Native state matching was checked in
[StreamStorage.cc](https://github.com/AnInsomniacy/aria2-next/blob/v2.8.3/src/stream/StreamStorage.cc).

The BT identity change was announced in
[issue 40](https://github.com/AnInsomniacy/aria2-next/issues/40)
and verified against released
[BitTorrentOptions.cc](https://github.com/AnInsomniacy/aria2-next/blob/v2.8.3/src/options/BitTorrentOptions.cc)
and [BtSettings.cc](https://github.com/AnInsomniacy/aria2-next/blob/v2.8.3/src/BtSettings.cc).
The default identity is `qBittorrent/5.2.3` with `-qB5230-`. These are global
libtorrent settings, not per-download `header` or legacy `peer-agent` options.

## Repeatable acceptance

From the repository root on Windows x64:

```powershell
pwsh -NoProfile -File truedown/tools/test-next-engine.ps1
```

The script fetches the reviewed 2.8.3 binary, verifies its pinned SHA-256 before
execution, runs all downloader tests with NEXT configuration, and restores the
caller's environment. `-EnginePath <absolute-path>` reuses an already downloaded
binary only if its checksum matches. It never installs or selects the user's
engine. CI runs this check for pull requests and before Windows release builds.

Real engine tests cover pause/resume/removal, unexpected exit, graceful
checkpoint/restart, repeated interrupted retries with nonzero Range requests,
missing checkpoint recovery, same-size remote replacement and conditional
refresh, filename resolution without network activity or task creation, and
BT identity startup, hot update, restart persistence and default restoration
via the real engine's global-option RPC.
Stable-engine tests retain legacy control-file corruption coverage. Native UI,
external service availability, live BitTorrent swarms and unpublished engine
versions are outside this compatibility acceptance.
