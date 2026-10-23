# Retain all output owners and anchor partial cleanup

- Rebuilding the ownership index preserves overlapping legacy records; removing
  or reassigning one record keeps every remaining reservation.
- Partial cleanup traverses retained directory handles, rejects parent links and
  reparse points, and detects directory replacement before opening a child.
- Windows automatic partial cleanup accepts local drive directories only.
- Destructive cleanup checks physical directory/file identities against every
  other task, covering short-name aliases and hard links of existing outputs.
- No database schema or dependency changes.

## Verification

- Focused Windows regressions cover restart overlaps, reservation release,
  symlink/junction parents and directory replacement before/after opening.
- Restored Windows short directory and short filename owners are protected in
  both cancellation directions.
- Full Go package tests and static analysis are recorded in the task report.
