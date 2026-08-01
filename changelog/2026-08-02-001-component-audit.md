# Component And Code Audit

## Summary

- Added `shared/ui.css`, `shared/ui.js`, and `shared/icons.svg` as the single source for extension-page tokens, controls, icons, focus states, notifications, busy states, and reduced-motion behavior.
- Kept popup sizing explicit in `popup/popup.css` and preserved the project-selected width while consolidating the surrounding layout and controls.
- Migrated popup and settings markup to the shared `kd-*` component vocabulary and removed duplicated inline SVG sprites, duplicated theme variables, and duplicated button/toast implementations.
- Scoped injected-page styles and animations to `kd-*`; Kemono, Pawchive, CoomerFans, and Favorites now share the same action, creator-card, modal, and flag components. Host hash classes and inline component styles are no longer required; legacy selectors remain only for one-time DOM upgrade detection.
- Added keyboard-accessible buttons, ARIA state/progress attributes, modal Escape handling and focus trapping, consistent transient state timing, and a reduced-motion fallback.
- Added the `settings.restoreDefaults` RPC. Backend, download rules, Watch, and Gist sync values are reset in one sync write; the creators override is disabled and the Watch alarm is rescheduled. Download history and the Watch list remain untouched. No new durable storage key or schema version was introduced.
- Removed the unused `db.loadDB`, `db.saveDB`, and `shouldMarkResult` exports.
- Added a minimal ESM `package.json`, shared UI/config regression tests, and the Favorites content stylesheet/script entries in `manifest.json`.
- Rewrote `AGENTS.md` as a current architecture/engineering contract, moved the former embedded history into `changelog/CHANGELOG.md`, and established sequenced dated release-note files under `changelog/`.
- Updated the GitHub publish workflow to select the newest `YYYY-MM-DD-NNN-*` changelog file and use it as the GitHub Release body instead of generated notes.

## Verification

```text
npm test
python -m unittest tests/migrate_history_json_test.py
pwsh -NoProfile -ExecutionPolicy Bypass -File tools/build-extension.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File tools/read-latest-changelog.ps1 -OutputFile release-notes.md
```

Manual visual checks cover dark/light themes, the configured popup width, 390px settings, creator cards, post buttons, Page Fetch, flag controls, and the external-link modal.
