# Update downloads

Program update archives and Aria2 Next binaries use the download queue. Their
task rows show transferred bytes, speed and progress, and support pause,
resume and removal. Downloaded packages remain available through their task
records in the profile's update/engine directories.

The updater verifies release metadata, size, SHA-256 and executable identity
before installing or staging anything. A completed download alone does not
mean the update has been installed. Settings shows verification, installation
and restart status. Program updates still require a numbered Windows desktop
package; NEXT remains an optional Windows engine.

The desktop and dashboard acknowledge manual update requests immediately, so
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
