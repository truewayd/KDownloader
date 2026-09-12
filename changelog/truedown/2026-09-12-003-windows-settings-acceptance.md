# TrueDown - Repair Windows settings acceptance

- Wait for the File management panel after opening file groups; the separate
  groups panel was removed by the settings reorganization.
- Save group edits with their independent save button. The page save shortcut
  now saves file options and intentionally preserves group drafts.

## Verification

- Hidden Windows native acceptance completed, including persisted group edits,
  task classification, retained drafts, core recovery, and shell crash cleanup.
- One earlier run failed a draft-retention assertion before reaching the group
  check; an unchanged rerun passed. No runtime workaround was introduced.
