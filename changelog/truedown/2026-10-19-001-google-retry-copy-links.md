# Resolver profile updates, Google Drive retries and task link copying

- Separate Google Drive response filenames from local output names, allowing
  existing tasks with folder titles or custom names to retry without a false
  filename-change error. Preserve output paths and subsequent remote identity
  checks.
- Make initial filename identity a module-declared metadata contract. Google
  Drive profile 1.0.1 selects response identity; the manager has no provider-ID
  naming exceptions. A hot profile update can change the supported policy while
  recorded remote identities remain protected.
- Publish Google Drive/Dropbox compatibility JSON and SHA-256 assets under
  independent module versions. Profile-only pushes skip application releases
  and native builds. Settings checks official releases, validates and atomically
  activates profiles, retaining manual imports and baseline restoration.
- Preserve newer manual imports during checks, retain active versions on any
  update failure, and prevent baseline resets racing the same module's update.
- Distinguish declarative profile updates from MEGA's signed executable updates.
  Google/Dropbox parser code remains compiled into the host; further executable
  separation is documented in `truedown/docs/resolver-modules.md`. This initial
  contract and the new copy controls require one application update.
- Add Copy download address to task context menus on all desktop platforms.
- Add Copy links to the floating selection toolbar, with one task link per line
  and retained links for selected tasks outside the virtual viewport.

## Verification

- Full Go tests and vet; existing failed-task recovery, remote metadata
  persistence and changed-source protection regressions.
- Native Rust tests, including menu action permissions, Windows labels and icons.
- Browser context menus and selection overlays in light/dark and narrow layouts;
  multi-task newline copying, MEGA fragment retention and offscreen selections.
- Node suite: 438 passed, one skipped; 13 Python migration tests; generated
  component consistency and whitespace checks.
- Profile publication fixtures, checksum/identity/version/configuration failures,
  cancellation, concurrent import, persisted activation and restore-baseline tests.
- Google Drive/Dropbox/MEGA settings update actions in light/dark native-size and
  narrow browser fixtures; module-specific sidebar retries and update statuses.
- Existing desktop task records were inspected read-only. The running installed
  application was not replaced; live Google transfers and native compositor
  behavior were not exercised.
