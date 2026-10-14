# aria2 NEXT compatibility audit

Reviewed on 2026-10-14 against the latest published release,
[v3.0.2](https://github.com/AnInsomniacy/aria2-next/releases/tag/v3.0.2),
commit `d518e90574e3b933e15aa70241bdc1f766a2dd14`. The previous 3.0.0 and
2.8.3 releases remain separate regression targets.
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
| Managed startup | Explicit `no-conf=true` and `daemon=false` keep ambient CLI configuration and NEXT 3.0.2's Windows daemon out of the owned process lifecycle. |
| HTTP compression | Keep NEXT 3.0.1+ native gzip defaults. Verify negotiated and unsolicited gzip responses are decoded, while a gzip archive without Content-Encoding remains byte-for-byte intact. |
| Live global settings | Continue using `aria2.changeGlobalOption`; NEXT 3.0.1 now notifies running tasks that inherit changed live options. No new task resubmission or option duplication is needed. |
| Ordinary HTTP | NEXT 3 receives `media=file`; downloading a playlist does not silently change task semantics. Explicit media tasks select `hls` or `dash`. |
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

## Patch release changes

[3.0.1](https://github.com/AnInsomniacy/aria2-next/releases/tag/v3.0.1) restores
`http-accept-gzip=true`, fixes inherited live global options and corrects the
Linux BitTorrent build's C++ standard mismatch. TrueDown keeps compression and
option propagation inside the native engine. Its existing runtime-settings
RPC applies concurrency, aggregate speed and supported BT identity settings.

[3.0.2](https://github.com/AnInsomniacy/aria2-next/releases/tag/v3.0.2) restores
XML-RPC, accepts bare flags in CLI configuration files, and implements Windows
daemon startup. TrueDown uses authenticated loopback JSON-RPC and an owned child
process, so it does not need another RPC transport or background process.
Explicit startup options bypass unrelated CLI configuration and prevent daemon
detachment. The restored XML-RPC route stays on the engine's private loopback
listener with its existing token; it is not a TrueDown HTTP API or native command.
Upstream no longer executes its release-time RPC BitTorrent smoke check; TrueDown
retains its independent real-engine acceptance before Windows publication.

## Reviewed releases and rollback

`internal/systemupdate/next-release.json` is the build's recommended NEXT version
and Windows AMD64/ARM64 SHA-256 policy. The Go core embeds it; the real-engine
acceptance script reads the same file. Updating the recommendation therefore
requires a tested TrueDown release. Discovery requests that exact official tag,
and installation checks both the published digest and the embedded digest.
Upstream's latest release does not change an already published TrueDown build's
recommendation. Automatic updates only upgrade already installed NEXT versions.

Settings displays the recommendation and offers the previous retained version
through `POST /system/engine/select` with `engine:"previous-next"`. Rollback
revalidates the retained file's SHA-256 and executable version before atomically
saving the selection, then reuses the normal task-preserving engine transition.
Missing, changed or unpersistable candidates leave the current selection intact.
The rejected version stays held across restarts, preventing automatic updates
from undoing the rollback. Explicit installation of the recommendation clears
the hold; a later TrueDown release may recommend a different reviewed version.

## Update entry points

Program and NEXT failures have independent bounded error fields in the public
update snapshot; retrying one does not clear the other. The compact information
area offers a sibling action button for the relevant updater and reuses the
same full operation as settings. Duplicate requests for one update kind share
the pending request. The module updater separately reports its ID, checking,
download and installation phases, with bounded task progress and no private
request data. Its retry enters the complete signed installation/activation flow.

Main-window native access is limited to the fixed update routes, engine selection
and read-only module/runtime status needed by this information area. Task forms,
details and previews do not gain update access. Ordinary task transfer retries
remain separate from these complete update actions.

Manual application restart refreshes the core's global interruption advisory
before choosing whether to confirm. An idle queue with no caller-owned drafts
restarts directly; unfinished tasks, active module updates or unsaved settings
require confirmation. Failed reads do not assume idle. The core's final
admission freeze and idle check remain authoritative if new work arrives later.

## Native HLS/DASH

Media execution requires NEXT 3 plus discovered `retryMedia`/`finishMedia` RPCs
and native `request-contexts`/`structured-errors` capabilities. The form exposes
HLS/DASH, MP4/MKV, and an optional live recording limit of 0–604800 seconds.
The untyped TrueDown headless extension accepts
`opts.media:{protocol:"dash",format:"mkv",recordTime:0}`; this is not an ABDM
DASH contract. ABDM HLS uses its existing `downloadSource.type:"hls"` or `/add`
item type and preserves suggested-name, headers, and initial pause semantics.

Known media requests are durably accepted even with an older engine. They keep
their queued/paused intent and expose `requiresMediaEngine:true`; ordinary files
in the same browser batch continue normally. No media RPC or file download is
attempted until a compatible engine is selected and the core restarts. Native
notifications report a separate bounded `engineRequired` counter, without
calling this a download failure. Waiting tasks can be paused or removed. This
does not auto-install/switch engines or accept unknown protocols/options.

NEXT selects the best tracks, resolves manifests and segment addresses, scopes
credentials by origin, transfers and caches fragments, and muxes/publishes the
output. TrueDown passes the original name as a title hint and observes the
published filename; it does not guess or reserve a remuxed container path.
Failed media uses `retryMedia` with the same GID. Pausing/restarting retains
native cache. Removal uses native cancellation/result retirement, with no
TrueDown media-cache traversal or partial-file deletion. Completed files remain.
Completion means native publication has finished. Duplicate completed media
stays completed rather than starting an HTTP conditional refresh.

Snapshots expose bounded media state, duration, received bytes and structured
error codes, excluding manifests, tracks and raw engine errors. Live tasks show
recorded duration rather than a fictitious percentage. `finish-media` on the
existing task batch route asks NEXT to finalize a live recording; the task only
completes after native publication.
Pause requests wait for the native paused state (or no active queue writers)
before TrueDown acknowledges them. The shared RPC wait has a five-second bound
and stops on manager shutdown, so immediate resume and live finalization cannot
overtake a pending pause. Terminal or unreadable states do not acknowledge an
individual pause as successful.
`GET /engine/capabilities` is read-only and native access is limited to new-task.
DRM-protected media remains unsupported. Arbitrary track selection, captured
browser manifests, and cross-origin credential contexts are not exposed yet.

## Link preflight

New download offers an explicit probe for one HTTP(S) link. The manager delegates
to [aria2.probe](https://github.com/AnInsomniacy/aria2-next/blob/v3.0.0/src/http/Probe.cc),
using the same headers, referrer and proxy configuration as submission. The
engine makes a bounded one-byte Range request and resolves redirects and response
metadata. No TrueDown task, native download task, output or checkpoint is created.
This inspects the source response, not media tracks or the eventual muxed size.

`POST /tasks/probe` accepts `{link, headers?, downloadPage?, opts?, useDefaults?}`
with the normal bounded transport validation. It returns numeric `status`, optional
`finalUrl`, `filename`, `contentType`, optional numeric `totalLength`, `resumable`,
and an optional generic `errorCode`. Unknown length is omitted rather than zero.
HTTP failures remain metadata results; raw native error messages are omitted.
Unusable engine support returns 409, concurrent overload 429, invalid input 400,
and RPC failures 502. Responses are not cached. Existing authentication and host
checks apply; native permission is limited to New download.

At most four probes can remain outstanding. Caller cancellation hides stale UI
results but retains the slot for the native operation, which has a 20-second
budget; the manager gives it 22 seconds. Transport failures retain their slot
until that deadline because closing RPC does not cancel the native request.
Closing/hiding, editing fields and automatic clipboard replacement invalidate
results. Results are literal text and never overwrite the draft or submit it.

## BitTorrent identity

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
pwsh -NoProfile -File truedown/tools/test-next-engine.ps1 -FFmpegPath C:\Tools\ffmpeg.exe
```

The script fetches the reviewed 3.0.2 binary, verifies its pinned SHA-256 before
execution, runs downloader/updater/API tests with NEXT configuration, and restores the
caller's environment. `-EnginePath <absolute-path>` reuses an already downloaded
binary only if its checksum matches. It never installs or selects the user's
engine. CI runs this check for pull requests and before Windows release builds.
Use `-Version 3.0.0` or `-Version 2.8.3` for the older engines. The reviewed
NEXT 3.0.2 Windows x64 digest is
`caa69e8ed4bdb2138b1b577f15ea9adecdf7c8230c6c3bb05c7c955383029de3`.

Real engine tests cover pause/resume/removal, unexpected exit, graceful
checkpoint/restart with nonzero Range requests, repeated interrupted retries,
missing checkpoint recovery, same-size remote replacement and conditional
refresh, filename resolution without network activity or task creation, and
BT identity startup, hot update, restart persistence and default restoration
via the real engine's global-option RPC. Managed startup is checked against an
invalid ambient CLI configuration containing a daemon flag. NEXT 3.0.1+ also
checks negotiated/unsolicited gzip decoding and preservation of gzip archives.
NEXT 3 also verifies that pause retains
native state and removal retires it without deleting an unrelated temporary file.
FFmpeg/ffprobe are developer-only fixture/oracle tools, never a production
download stack. Media acceptance generates HLS and DASH, verifies decoded video
frame hashes and audio/video tracks, retained cache across retries/restart,
paused live finalization, native deletion, and cross-origin credential isolation.
Native probe acceptance covers Range metadata, encoded filenames, known/unknown
and empty lengths, same/cross-origin redirects, Cookie/Authorization isolation,
HTTP errors, API admission boundaries and the absence of task/output side effects.
The real 2.8.3 lane retains queued/paused media without sending it to the engine,
completes ordinary HTTP with concurrency set to one, removes waiting records
without touching completed output, and rejects probing without network activity.
Stable-engine tests retain legacy control-file corruption coverage. Native UI,
external service availability, live BitTorrent swarms and unpublished engine
versions are outside this compatibility acceptance.
