# TrueDown components

In TrueDown 2.0.0, the HTTP listener is an API-only service for the CLI and
integrations. It serves no webpage or frontend assets and accepts no browser
session cookies. Use the [native desktop application](desktop/README.md) for
the graphical interface; its bundled windows communicate with the core through
private native IPC.

Dropbox and Google Drive each have two layers:

- A compiled resolver engine owns parsing, task creation, trusted-host checks,
  response limits, recursion limits, and credential handling.
- A small declarative component package owns provider compatibility values such
  as endpoint paths, CSRF cookie names, and the resolver User-Agent.

This boundary lets provider compatibility updates ship independently without
loading executable plugins or weakening the download manager's security model.

## Lifecycle

The baseline packages in `internal/downloader/module_baselines/` are embedded in
the TrueDown core binary. They are always available, including when a user update is
missing, corrupt, incompatible, or older than the embedded baseline.

In the native desktop application, open **Settings > Engine and modules**.
The resolver-component cards support three separate actions:

- **Enable / Disable** changes whether the resolver claims new links. It does
  not delete a component version or affect existing module-tagged tasks.
- **Import update** validates a local JSON package, persists it as
  `<profile data role>/modules/<id>.json`, and activates an immutable snapshot
  immediately. In-flight calls finish on their old snapshot.
- **Restore baseline** removes the independent package and atomically activates
  the version embedded in the running TrueDown core.

The module list reports the active version, baseline version, release date,
source, hot-reload support, and the SHA-256 digest computed from normalized
package content. Updates must be strictly newer than both the embedded baseline
and any active update; restoring the baseline is the explicit downgrade path.

## Package envelope

Packages are UTF-8 JSON objects no larger than 64 KiB. Unknown fields are
rejected at every level.

```json
{
  "schemaVersion": 1,
  "id": "google-drive",
  "engine": "google-drive-v1",
  "version": "1.1.0",
  "releasedAt": "2026-08-20",
  "config": {}
}
```

`version` uses canonical `major.minor.patch` numeric components. `releasedAt`
uses `YYYY-MM-DD`. The `id` and `engine` must match one of the engines compiled
into the current TrueDown release.

### Dropbox `dropbox-v1`

```json
{
  "folderEntriesPath": "/list_shared_link_folder_entries",
  "csrfCookieNames": ["__Host-js_csrf", "t"],
  "userAgent": "Mozilla/5.0"
}
```

The endpoint path is always resolved against the compiled, trusted
`https://www.dropbox.com` origin. Cookie names and header values are bounded and
cannot contain control characters.

### Google Drive `google-drive-v1`

```json
{
  "stableDownloadPath": "/uc",
  "openPath": "/open",
  "folderViewPath": "/embeddedfolderview",
  "nativeExportPath": "/{type}/d/{id}/export",
  "userAgent": "Mozilla/5.0"
}
```

Drive paths remain on compiled `drive.google.com` or `docs.google.com` origins.
`nativeExportPath` must contain exactly one `{type}` and one `{id}` placeholder;
both are path-escaped before use. A package cannot add redirect hosts, lower
response or traversal protections, introduce aria2 arguments, or run code.

## HTTP API

- `GET /modules` returns component and enablement state.
- `POST /modules` accepts `{ "id": "...", "installed": true }` for backwards
  API compatibility; the flag now means enabled for new-link routing.
- `POST /modules/package` accepts `{ "package": <package-object> }` and returns
  the newly active component description after persistence succeeds.
- `DELETE /modules/package?id=<module-id>` restores the embedded baseline.
- `POST /system/exit` requests the same graceful process shutdown used by the
  Windows tray and Unix signals.

The endpoints use the same origin and `X-Api-Key` protection as other TrueDown
write APIs. When API authentication is enabled, HTTP clients send `X-Api-Key`;
the native desktop interface uses its private IPC connection instead of browser
login sessions.

## Tracker traffic research module

The experimental tracker-research module is compiled into TrueDown but is off
by default. It reproduces RatioGhost's announce-counter model for controlled
traffic studies without changing the aria2-next source tree. Enabling it is a
separate action in native **Settings > Experimental** that requires an explicit risk acknowledgement and a
running Aria2 Next build exposing `aria2.replaceBtTrackers`.

When enabled, TrueDown reads each BitTorrent task's tiered announce list from
`tellStatus`, replaces only HTTP and HTTPS entries with opaque URLs on an
automatically allocated `127.0.0.1` relay, and leaves UDP and unknown tracker
schemes unchanged. The relay accepts GETs only for generated tracker tokens and
queries containing `info_hash`; it is not a general HTTP proxy. Original
tracker URLs are persisted with owner-only permissions so they can be restored
after a restart or when the module is disabled. API and native desktop status never
return tracker URLs, passkeys, info hashes, or relay tokens.

The relay terminates no client TLS connection. For an HTTPS tracker it makes a
normal HTTPS request to the original tracker using Go's certificate validation,
then returns the tracker response on loopback. This avoids a MITM CA or custom
certificate because Aria2 Next is explicitly pointed at the local relay URL.

The saved research model exposes the leecher threshold, real-download and
real-upload multiplier ranges, optional KiB/s bonus and probability, download
counter suppression, and seed simulation. Seed simulation implies download
counter suppression. The leecher count comes from the previous bencoded tracker
response's `incomplete` value, matching RatioGhost's announce/response order.
Settings and restorable tracker lists live in
`<profile state role>/truedown.tracker-research.json`; risk acknowledgement is not stored.
The module has no independent updater and follows the TrueDown release lifecycle.

- `GET /settings/tracker-research` returns saved settings, fixed transport and
  isolation properties, non-sensitive counters, support state, and the warning.
- `POST /settings/tracker-research` validates the complete settings object.
  `acknowledgedRisk` must be true only for the disabled-to-enabled transition.

## BitTorrent import, layout, and resume

BitTorrent task creation is available only while the selected engine is Aria2
Next. The native new-task window accepts a local `.torrent` file of at most 4 MiB, a
magnet link, or an HTTP(S) torrent link. Imported metainfo is strictly bounded
and bencode-validated before it is persisted in the task identity, allowing the
same metainfo to be submitted again after a TrueDown restart. The task-list API
continues to omit this internal request payload.

The selected save directory is always the torrent's root save path. TrueDown
does not pass aria2 an `out` override for BitTorrent tasks: a single-file
torrent therefore writes the file directly in the selected directory, while a
multi-file torrent retains its metainfo root and creates the torrent-named
directory. This is the mandatory smart-folder mode and is not exposed as a
second folder toggle.

Aria2 Next runs with a private `<profile state role>/aria2-next-state` fast-resume store,
startup integrity checking, and a one-second BT resume-save interval. On
restart, TrueDown first attaches to an existing native torrent with the saved
GID; otherwise it resubmits the durable magnet, torrent URL, or imported
metainfo with the same GID and `check-integrity=true`. Aria2 Next then validates
the selected directory's existing pieces instead of assuming that a matching
filename is complete. HTTP(S) torrent URLs initially create a metadata download
whose `followedBy` BT child has a different GID; TrueDown detects that child,
rebinds the task, and persists the child GID for later control and resume.

The official Aria2 Next binary owns its complete BitTorrent identity. Current
NEXT uses libtorrent-rasterbar and reports an `aria2-next/<version>
libtorrent/<version>` tracker/extended-handshake User-Agent with an `A2`
versioned peer fingerprint. Its compatibility adapter intentionally ignores the
retired aria2 `peer-agent` and `peer-id-prefix` options, so TrueDown does not
offer misleading controls that would change only part of the identity.

TrueDown requests native peer, seeder, connection-candidate, tracker-count, and
availability fields in its bounded status poll and includes them in BT task
progress, making a zero transfer rate distinguishable from missing metadata or
peer discovery. Aria2 Next v2.6.5 and newer also writes its redacted native
libtorrent diagnostics to rotating `<profile logs role>/aria2.log` files at debug level
(10 MiB each, four files); its warning console stream is kept separately in
`<profile logs role>/aria2-console.log`. Open native **Settings > Logs** to
inspect logs. Older engines retain the summarized console log.

When Aria2 Next reports `The requested byte range is no longer satisfiable`,
the remote HTTP object no longer matches the saved resume position. This exact
retry path is marked as destructive in the native task list: after confirmation it
removes only the task's validated direct-child partial file and recovery
sidecar, then submits the task from byte zero. Deleting the file also causes
Aria2 Next to drop its path-keyed native stream state during fresh admission.
Other failures keep their resumable data.

- `POST /start-bt-download` accepts exactly one of `link` or `torrentBase64`,
  plus the selected folder and bounded aria2 options.
- Stable aria2 remains available for ordinary HTTP(S) downloads but rejects
  the Aria2 Next-only BitTorrent import path with a validation response.

## Program and download-engine updates

Open native **Settings > Engine and modules** to manage program and engine
updates. TrueDown treats its native application package and its download engine
as separate update domains:

- Every Windows package contains the reviewed stable `aria2c.exe`. A program
  update replaces `TrueDown.exe`, the matching `truedown-core.exe` and
  `truedown-cli.exe`, and their notices together; it never replaces the packaged stable
  engine, a manually installed NEXT engine, the database, or other data files.
- Linux and macOS resolve stable aria2 from their package, an explicit
  `TRUEDOWN_ARIA2_PATH`, the system `PATH`, or standard Homebrew locations.
  Aria2 Next and program self-update remain Windows-only.
- Aria2 Next is optional and must first be installed and selected explicitly.
  TrueDown downloads the exact
  Windows asset and checksum list from the latest stable
  `AnInsomniacy/aria2-next` GitHub Release, verifies SHA-256 and the executable's
  reported NEXT version, then stores it under `<profile data role>/engines/`. Installing
  or updating NEXT never changes the engine preference. The user separately
  selects NEXT or the built-in stable engine. TrueDown drains active manager
  requests, gracefully stops the old downloader manager, starts the verified
  target, and restores unfinished tasks from the durable database while the
  HTTP listener remains available. A failed target startup restores the prior
  engine. Unexpected engine exits retry the active engine three times before a
  bounded TrueDown self-reload. Stable selection is rejected while unfinished
  BitTorrent tasks exist.
- A separate automatic-update preference checks newer stable versions of an
  already installed NEXT engine. New profiles enable this preference; existing
  profiles retain manual updates. Verified updates switch an active NEXT engine
  only while idle and retain the previous working engine for recovery.
- TrueDown releases include `truedown-update-<build>.json`. The running program
  considers only non-prerelease `truewayd/KDownloader` releases whose tag,
  archive, and manifest names match the build number. The manifest binds the
  archive name, byte size, and SHA-256 digest. The schema-2 native manifest also
  binds the complete interface/core/CLI set and notices before staging them
  under `<profile state role>/updates/`.
- Applying a staged program update uses an external helper. It waits for
  TrueDown and aria2 to stop, retains the previous file set, starts the
  replacement, and waits for a per-update native frontend health acknowledgment.
  A failed startup restores and relaunches the complete previous version.

Program and NEXT assets appear as tasks in the native task list, with normal
pause, resume, and removal controls. Verification still completes before
installation. Restart failed or interrupted attempts from the update controls;
retrying an old download task alone does not apply an update.

The durable preferences and verified installed-file metadata live in
`<profile state role>/truedown.updates.json`. Automatic TrueDown updates default to
enabled for numbered Windows release builds, check periodically, and apply only
when there are no queued, downloading, or paused tasks. Development builds can
display the controls but cannot self-update. A standalone `truedown-core`
service cannot apply program updates, including previously staged ones; manual
engine management remains available. To migrate an old browser-only Windows
installation, exit it and extract a complete native package.

Profile roles above are the paths reported by `truedown-cli --json paths`;
`--data-dir` selects the profile root, not a flat directory for every file.

Update endpoints use the same origin and `X-Api-Key` protection as the rest of
the HTTP API:

- `GET /system/update` returns program and engine state.
- `GET/POST /settings/updates` reads or changes program and NEXT automatic updates.
- `POST /system/update/check` checks and stages a numbered TrueDown release.
- `POST /system/update/restart` applies an already staged program update.
- `POST /system/engine/next` manually installs or updates Aria2 Next.
- `POST /system/engine/select` selects and asynchronously activates `stable` or
  an installed `next` engine.

`POST /system/update/check` and `POST /system/engine/next` accept
the `?background=true` query parameter to return HTTP 202 with a busy
snapshot. Poll `GET /system/update` for completion.
