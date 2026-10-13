# aria2 NEXT compatibility audit

Reviewed on 2026-10-13 against the latest published release,
[v3.0.0](https://github.com/AnInsomniacy/aria2-next/releases/tag/v3.0.0),
commit `40d9fe5807368a8ebb0c063ff81d5b5214d6ad7f`. The previous 2.8.3 release
remains a separate regression target.
Unreleased main-branch behavior is not treated as a release contract.

| Surface | TrueDown adaptation |
| --- | --- |
| Native HTTP recovery | Preserve GID for paused/process-interrupted recovery. NEXT 2.x also preserves GID for same-URL failed retries. NEXT 3 failed HTTP retries restart from zero because result retirement discards native state and no HTTP retry RPC exists. Never infer completion from file size. |
| Missing/incompatible recovery state | Native error 13 leaves output intact and offers an explicit clean retry. Existing range-error cleanup also remains bounded to the owned output. |
| Output collisions | Reserve payload/control pairs, pin `out`, and disable automatic renaming and overwrite. NEXT 3 uses `continue=false` to forbid prefix adoption while retaining native checkpoint loading. Explicit clean retry delegates owned-output truncation to the engine. Completed-file conditional refresh remains separate. |
| Dropbox / Google Drive | Recognize native partials without `.aria2`. A renewed source URL cannot inherit another URL's checkpoint; restart after metadata checks. Refreshed transient Google URLs remain engine-validated and may require a clean retry. |
| Filename RPC | Discover `aria2.resolveFilename` through `system.listMethods`; keep older `getVersion.downloadFeatures` as fallback if discovery fails. Send original Content-Disposition as integer bytes. Bound URL/header lengths to 16384/8192 bytes and use a one-second deadline. |
| Filename callers | Use the optional RPC for resolver metadata, with local-parser fallback. Caller-provided output names and existing output reservations stay authoritative. Ordinary unnamed HTTP tasks keep their URL-derived names. |
| Update discovery | Accept both `Aria2 Next version` and `aria2-next version` banners; retain executable/SHA-256 validation. |
| Checkpoint options | NEXT 3 uses `state-save-interval=1`; older engines retain HTTP auto-save 5s and supported BT resume-save 1s. Reject retired range and task-level checkpoint overrides. |
| Windows shutdown | NEXT 3 uses authenticated shutdown RPC; CTRL_BREAK does not checkpoint. Stable/NEXT 2 retain the hidden interrupt helper. |
| Ordinary HTTP | NEXT 3 receives `media=file` until explicit media admission is supported; downloading a playlist does not silently change task semantics. |
| BitTorrent identity | Align the previously missed 2.6.7 global `bt-user-agent` and `bt-peer-id-prefix` options. Persist, hot-apply and restore through runtime settings; gate engine arguments and RPC options to NEXT 2.6.7+. Keep HTTP identity independent. |
| Diagnostics / native IPC / browser API | No new native commands or supported URL protocols. The existing runtime-settings endpoint accepts optional `btUserAgent` and `btPeerIdPrefix`; partial updates preserve omitted fields. |

The filename method is local computation: no remote request and no download
task. The wire format and advertised feature were checked in the released
[SessionMethods.cc](https://github.com/AnInsomniacy/aria2-next/blob/v2.8.3/src/rpc/SessionMethods.cc).
Native state matching was checked in
[StreamStorage.cc](https://github.com/AnInsomniacy/aria2-next/blob/v2.8.3/src/stream/StreamStorage.cc).

NEXT 3 behavior is verified in released [HttpTask.cc](https://github.com/AnInsomniacy/aria2-next/blob/v3.0.0/src/http/HttpTask.cc)
and [Engine.cc](https://github.com/AnInsomniacy/aria2-next/blob/v3.0.0/src/core/Engine.cc).
Native checkpoints load independently of `continue`. Missing native state must
produce a file conflict, preserving preallocated bytes until explicit retry.
Retry retires the stopped result/state, uses a fresh GID and grants overwrite
only after manager ownership/path checks. Never copy checkpoint rows or rebuild
range maps. Do not persist `remove-control-file=true`: it would also discard
the new checkpoint on a later pause/resume.

Cancellation stops the writer and retires native state through engine RPCs.
Cleanup failure preserves the manager record. These RPCs do not unlink ordinary
HTTP outputs, so confirmed unfinished-file removal retains the existing bounded
local cleanup. Completed outputs and foreign files are preserved. Module
artifacts and updater caches remain separate TrueDown-owned resources.
Production code never opens or walks the engine checkpoint database/directory.

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

The script fetches the reviewed 3.0.0 binary, verifies its pinned SHA-256 before
execution, runs downloader/updater/API tests with NEXT configuration, and restores the
caller's environment. `-EnginePath <absolute-path>` reuses an already downloaded
binary only if its checksum matches. It never installs or selects the user's
engine. CI runs this check for pull requests and before Windows release builds.
Use `-Version 2.8.3` for the older engine. The reviewed NEXT 3 Windows x64 digest is
`edf8d987abb3055f34b09a190b4d533950a186ddae9013b9fb83948ee3a5f438`.

Real engine tests cover pause/resume/removal, unexpected exit, graceful
checkpoint/restart with nonzero Range requests, repeated interrupted retries,
missing checkpoint recovery, same-size remote replacement and conditional
refresh, filename resolution without network activity or task creation, and
BT identity startup, hot update, restart persistence and default restoration
via the real engine's global-option RPC. NEXT 3 also verifies that pause retains
native state and removal retires it without deleting an unrelated temporary file.
Stable-engine tests retain legacy control-file corruption coverage. Native UI,
external service availability, live BitTorrent swarms and unpublished engine
versions are outside this compatibility acceptance.
