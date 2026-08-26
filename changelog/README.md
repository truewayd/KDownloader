# Changelog Workflow

Release notes live in this directory and are deliberately separate from `AGENTS.md`.

- Put KDownloader notes in `changelog/kdownloader/` and TrueDown notes in `changelog/truedown/`. Changes affecting both products require one product-specific note in each directory.
- Keep one release-note file per product update, named `YYYY-MM-DD-NNN-short-slug.md`; increment the zero-padded sequence when several updates land on one day.
- Put the user-visible summary, compatibility/configuration impact, and verification commands in that file.
- `CHANGELOG.md` is the historical archive. Do not add new dated entries to `AGENTS.md`.
- Root-level dated files predate product-scoped release notes and are retained as history; publish workflows do not select them.
- `tools/read-latest-changelog.ps1 -Product KDownloader|TrueDown` selects the lexicographically newest dated file for that product. Each GitHub publish workflow watches and selects only its own product directory.
