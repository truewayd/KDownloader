# Update downloads

Program update archives and Aria2 Next binaries use the download queue. Their
task rows show transferred bytes, speed and progress, and support pause,
resume and removal. Downloaded packages remain available through their task
records until installation succeeds. The updater then removes the verified
download, its aria2 control file, completed task record and empty download
directories. Ordinary downloads are unaffected.

The updater verifies release metadata, size, SHA-256 and executable identity
before installing or staging anything. A completed download alone does not
mean the update has been installed. Settings shows verification, installation
and restart status. Program updates still require a numbered Windows desktop
package; NEXT remains an optional Windows engine.

With automatic updates enabled, Windows checks about eight seconds after startup
and every twelve hours thereafter, then downloads and verifies eligible updates.
Pending updates are considered for application every thirty seconds while waiting
for an idle queue.
The main sidebar reports the updater-owned task's progress, speed, queued/paused
state and verification, even when task filters hide that download. A verified
program update exposes a confirmed restart action; automatic idle restarts retain
their existing behavior. Update failures and engine recovery use the same compact
notice. No notice is shown when there is nothing to report. Status reads suspend
while the window is hidden and retry with bounded backoff after a disconnect.

Program packages are cleaned only after the new desktop and core pass startup
health verification and the update helper clears its transaction marker.
Staging, an interrupted update or a rollback never authorizes cleanup. NEXT's
download is cleaned after its verified executable and installation metadata
have been committed; the installed executable and previous engine remain.
Cleanup failures are retried after startup and every 30 seconds. Identical
failures across candidate directories are consolidated into one log line with
a candidate count. Within one process, a retained receipt is logged again only
when its failure reason changes; successful cleanup clears that suppression.
A checksum mismatch still preserves the output and the receipt for later retry.
A bounded `state/truedown.update-downloads.json` journal keeps this work durable
without changing the update settings format understood by rollback binaries.
Only verified downloads have cleanup receipts; older untracked download packages
are not swept by filename or age. Cleanup also requires any surviving task record
to carry the private updater-owned flag. Ordinary tasks, their outputs and resume
data are never eligible, even if their names and bytes match an update package.

## Cache retention

The updater reclaims its own storage only. It never scans the user's download
directory or runs ordinary task-cache maintenance. No new setting or cleanup API
accepts a caller-supplied deletion path.

- Program and NEXT maintenance runs after update operations, at startup and on
  the existing 30-second maintenance tick. An unfinished native transaction,
  active update or launched apply helper prevents pruning.
- Unreferenced native staging directories, helper/transaction files and temporary download copies become
  eligible after 24 hours. Stages accept only the fixed five application files;
  foreign files, nested directories and links block removal. The pending stage
  is always retained. The existing single `.previous` backup set remains for
  recovery; it does not accumulate one set per release.
- NEXT retains the selected candidate, the running engine and the recorded
  previous engine. Other versioned binaries become eligible after 24 hours.
  Unfinished verified-download receipts protect their installed binary until
  package cleanup can be retried, including receipts superseded by a newer NEXT.
- Executable modules reclaim verified update downloads and their queue records
  after successful activation, and retry on startup or a subsequent update check.
  Their signed installed manifests act as durable receipts. Startup, before any
  module process is admitted, retains the selected and previous selected versions
  (newest older version for pre-governance installs), and prunes older versions
  after 24 hours. A separate `previous.json` preserves old-host compatibility.
  Newer unactivated candidates
  remain for diagnosis/retry. Runtime activation never removes old executables
  that running artifact work may still reference.
- Startup also reclaims old embedded-module digest directories and abandoned
  module install/copy stages after 24 hours. The currently bundled digest stays.

Pruning is bounded, nonrecursive and rejects directory aliases. Locked files or
unexpected contents are logged and preserved for a later maintenance/startup
attempt. Failed or paused update downloads without a successful installation
remain available; this policy does not silently discard user-controlled tasks.

## Platform locations

- Windows installs updates in place beside the running `TrueDown.exe`, replacing
  the shell, core, CLI and notices together. The default profile is
  `%LOCALAPPDATA%/TrueDown`. Program downloads live under
  `state/updates/download-<id>/<file-group>/`; extracted staging files live under
  `state/updates/native-build-<build>-<id>/`. NEXT downloads live under
  `data/engines/download-<id>/<file-group>/`; the installed versioned engine is
  directly in `data/engines/`. Old application `.previous` files are rollback
  backups, not downloaded packages, and remain available.
- Linux AMD64/ARM64 updates are manual: extract the new archive to the chosen
  application directory. The download remains wherever the browser saved it.
- macOS ARM64 updates are manual: replace `TrueDown.app`, normally in
  `/Applications` or `~/Applications`. The ZIP remains in the browser's selected
  download directory. TrueDown does not delete manually downloaded archives on
  either Unix platform.

Explicit profiles, environment-selected profiles and migrated adjacent Windows
profiles use their saved layout instead of the defaults. `truedown-cli --json
paths` reports the actual profile directories. File groups can rename the
single directory beneath each `download-<id>` folder.

The desktop and HTTP API acknowledge manual update requests immediately, so
waiting in the queue or pausing does not hold a long-lived HTTP or native IPC
request. Settings reads status separately. Automatic application still waits
for an idle queue and honors the saved automatic-update switches.

Removing an update task cancels that update attempt. If an attempt fails or
TrueDown exits before verification, start the update again from Settings.
Retrying a retained task alone never authorizes installing its contents.

The download engine reads a temporary, single-asset loopback endpoint. The
updater retains control of HTTPS hosts, redirects, byte limits and checksums;
the endpoint accepts no arbitrary URL or browser-origin request and closes
when the attempt ends. Upstream release URLs and credentials cannot be supplied
through the update API.
