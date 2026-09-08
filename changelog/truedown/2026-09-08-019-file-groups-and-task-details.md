# File groups, task information and simpler download forms

- Add editable file groups for images, video, music, archives, applications,
  documents, engineering and Other. The engineering group starts with the same
  ten suffixes as the default Dropbox project-file exclusion list.
- Create, rename and remove groups or edit their suffixes in Settings > File
  groups. Rules persist per profile, match case-insensitively and prefer longer
  suffixes. Existing tasks update immediately without moving downloaded files.
- Combine group, status and search filters across all task pages. Status filtering
  lives only in the top dropdown; the sidebar contains file groups and utilities.
- Open a task's information/settings pages from its filename. View size, progress,
  speed, remaining time, source and directory; copy its link or operate the task.
  Save per-task speed/connection/retry preferences with stale-write protection.
  Active tasks support immediate speed changes; pause before changing connection
  and retry settings. Completed tasks remain read-only.
- Simplify creation to the source, save location and filename, with advanced
  options collapsed. Resolver settings are inherited from application preferences.
  Reduce the native new-task window size and retain window-edge/top padding.
- Upgrade five pinned GitHub Actions dependencies. Fix profile test assumptions
  about canonical temporary paths on Windows/macOS. Give hidden Windows acceptance
  a startup budget covering the core handshake and subsequent WebView creation,
  with bounded readiness requests and stage-specific failure diagnostics.

## Verification

Go tests and vet pass on Windows; the Linux test binaries and core smoke pass in
WSL. Coverage includes persistence failure rollback, classification before
pagination, stale writes, private settings and strict API bounds. Rust formatting,
Clippy and 17 native unit tests pass. Chromium group/detail interactions pass in
both themes at desktop/mobile widths, alongside native-form and workspace checks.
Hidden Windows acceptance covers group saving with Ctrl+S, native task details,
creation drafts, authentication, appearance, recovery and process cleanup.
Packaged-core acceptance verifies live speed changes, paused connection/retry
edits and group/settings persistence across a real engine restart. The optimized
Windows package passes matched shell/core/CLI startup and graceful exit.
Hosted Windows startup and macOS runtime acceptance require the next CI run.
