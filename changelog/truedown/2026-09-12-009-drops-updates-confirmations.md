# TrueDown 1.7.0

- Drop a local `.torrent` file into the desktop main/task window to open the
  new-download form. HTTP(S) and Magnet links can also fill the form. Sources
  are bounded and existing drafts require confirmation before replacement.
- Program and Aria2 Next update packages now use visible download tasks with
  progress, speed, pause, resume and removal. Release and checksum validation
  remain mandatory before installation. Manual update requests are accepted
  immediately and monitored separately from their download lifetime.
- Desktop deletion and other confirmation prompts now use separate, parented
  system dialogs. Browser dashboards retain the in-page confirmation UI.
- Retry and Retry all run without a second confirmation. Remove the old clean
  restart prompt and instructional copy while retaining output safety checks.
- Preserve the existing Windows package and optional NEXT update support limits.

## Verification

- Go unit tests and real aria2 update downloads with observable progress,
  pause/resume, retained output and final content verification.
- Chromium form acceptance in light/dark themes, including dropped torrents,
  dropped links, draft replacement, cancellation and native confirmation calls.
- Rust unit tests and hidden Windows WebView2 startup, window, task-form and
  engine-recovery acceptance.
