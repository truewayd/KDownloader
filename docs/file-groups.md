# File group configuration

TrueDown stores groups in the profile configuration file
`truedown.file-groups.v2.json`. Small, bounded configuration stays in one atomic
JSON document; download records remain in SQLite. An ordered API snapshot is a
view of that document, not the persistence representation.

```json
{
  "schemaVersion": 2,
  "revision": 12,
  "order": ["project", "other"],
  "groupsById": {
    "project": {
      "name": "Engineering",
      "icon": "settings",
      "directory": "Projects",
      "extensions": [".psd", ".blend", ".work.project"]
    },
    "other": {
      "name": "Other",
      "icon": "file",
      "directory": "Other",
      "extensions": []
    }
  }
}
```

## Ownership and validation

- A map key is the stable group identity. Renaming changes only the definition;
  reordering changes only `order`. No duplicate ID is stored inside a definition.
- `order` must contain every map key exactly once. Unknown, repeated, omitted or
  unlisted IDs are rejected. Duplicate JSON identity keys are rejected too.
- The document accepts 1-32 groups and at most 128 suffixes per group. Names are
  unique, icons refer to the bundled catalog, and directories are safe single
  path components. `other` is the required empty-suffix fallback.
- Suffixes are normalized to lowercase dotted values. Compound suffixes are
  supported, longest match wins, and two groups cannot own the same suffix.
- `project` is the stable identity followed by Dropbox's project filtering;
  the displayed name may change. Deleting it disables project filtering.
- The core fills default icons and directories when accepting editor input;
  the persisted document always contains explicit values. Derived suffix indexes,
  task counts and available-icon catalogs are never stored in this document.
- `revision` protects writes from stale editors and remains within JavaScript's
  safe integer range. The existing reorder endpoint accepts only the revision
  and a permutation of all IDs; it cannot change group definitions.
- The existing bounded regular-file reader and same-directory synchronized
  atomic writer enforce the 64 KiB limit and crash recovery. Corrupt or unknown
  v2 data fails validation rather than being silently replaced.

## Fresh configuration, without old-format migration

The old `truedown.file-groups.json` file is not read, converted, overwritten or
deleted. If the v2 file does not exist, the core writes a fresh default document.
This intentionally resets custom group configuration from the old format.

Existing task files and their persisted output paths remain in place. Task-list
classification uses the new rules; fresh tasks use the new group directories.
Dropbox's independent custom-filter list and directory-download preference stay
in their existing configuration file.

## Implementation

- `truedown/internal/downloader/file_groups_config.go`: disk schema and encoding.
- `truedown/internal/downloader/file_groups.go`: definitions, validation, snapshots
  and revision-checked mutations.
- `truedown/internal/profile/profile.go`: profile-owned filename.
- `truedown/web/file-groups.js`: editor drafts, conflict reconciliation and sorting.
