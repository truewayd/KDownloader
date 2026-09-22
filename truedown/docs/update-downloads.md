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

Program packages are cleaned only after the new desktop and core pass startup
health verification and the update helper clears its transaction marker.
Staging, an interrupted update or a rollback never authorizes cleanup. NEXT's
download is cleaned after its verified executable and installation metadata
have been committed; the installed executable and previous engine remain.
Cleanup failures are logged and retried after startup and every 30 seconds.
A bounded `state/truedown.update-downloads.json` journal keeps this work durable
without changing the update settings format understood by rollback binaries.
Only downloads verified by this version have cleanup receipts; older untracked
packages are not swept by filename or age.

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
