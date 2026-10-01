# TrueDown settings guidance and file-group navigation

- Move advanced aria2 parameters under the download core in Engine and modules,
  preserving autosave, search, category reset and the old settings route.
- Move Dropbox directory and suffix-filter controls into its module card. Retain
  settings while disabled and disable filter editing in archive mode. Engine and
  modules reset includes Dropbox preferences; File management retains groups.
- Link Dropbox project filtering directly to the group editor with smooth
  scrolling and reduced-motion support. Do not repeat the group's suffixes.
- Persist filtering as off when the project group is deleted; repair older
  references on startup. Preserve the independent custom suffix list and folder
  download mode. Restoring the group does not re-enable filtering.
- Reuse one information, warning and error notice component across settings and
  task guidance, retaining links and live-region semantics and hiding empty
  feedback. Keep concise field constraints as plain help.
- Give ordinary task rows a compact group-icon surface; honor custom group icons
  and use a file fallback for unknown groups. Update task indicators are retained.
- Rename Download and speed to Download and network; move the default save
  directory, including autosave and reset, into File management. Clarify immediate
  queue changes versus new-task defaults. Separate browser/API connection and
  data storage panels, remove nested guidance borders and label program updates.

File groups now use schema 2 in `truedown.file-groups.v2.json`, with definitions
keyed by stable ID, explicit icons/directories and a separate ordering list.
The old file is ignored and left untouched; first use initializes default groups.
Existing task files and output paths are retained. Invalid v2 documents are
rejected. This intentional storage break advances the shared product version to
3.0.0 under the repository versioning contract. No new permissions or endpoints.

## Verification

- `npm run ui:check` and `npm test`.
- `node tests/settings-browser-smoke.mjs` and
  `node tests/file-groups-browser-smoke.mjs` from `truedown/desktop`.
- `go test ./...` and `go vet ./...` from `truedown`.
- Browser checks cover light/dark themes, desktop/narrow widths, drafts,
  navigation, notice visibility and group icons. Native compositor acceptance
  and release publication are separate from these browser checks.
