# Continuous task workspace

- Match settings/main navigation widths, use pill search fields and balance logo
  spacing. Fix auxiliary window sizes while preserving small-monitor fitting.
- Present compact live download details with real aria2 piece maps and sanitized
  connection speeds, bounded/cancellable reads and retained settings drafts.
- Show active/error counts and aggregate download speed in the sidebar when no
  update notice needs attention; keep update progress and failures prioritized.
- Add total task counts to file groups, including completed tasks and independent
  of the current search/status filter. Maintain counts and speed incrementally.
- Combine search, status, queue actions and the right-aligned directory control
  into one responsive toolbar; hide retry/cleanup when space is limited.
- Replace visible pagination with continuous virtual scrolling, bounded viewport
  reads, overscan, conditional refreshes and keyed row updates.
- Keep CLI status/list parsing compatible with the extended task overview and
  preserve group counts and 64-bit aggregate speed in JSON output.

## Verification

- Go overview mutation/filter tests and the full Go test suite; go vet.
- 2400-task browser acceptance at 1200px, 960px and 390px, including last-row
  navigation, bounded DOM, node reuse, search reset and global statistics.
- Workspace, sidebar notice and group browser regression checks.
- CLI plain/JSON regression checks with nested group counts and large speeds.
