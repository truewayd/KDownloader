# Changelog Workflow

Release notes live in this directory and are deliberately separate from `AGENTS.md`.

- Keep one release-note file per update, named `YYYY-MM-DD-NNN-short-slug.md`; increment the zero-padded sequence when several updates land on one day.
- Put the user-visible summary, compatibility/configuration impact, and verification commands in that file.
- `CHANGELOG.md` is the historical archive. Do not add new dated entries to `AGENTS.md`.
- `tools/read-latest-changelog.ps1` selects the lexicographically newest dated file. The GitHub publish workflow uses its output as the Release body.
