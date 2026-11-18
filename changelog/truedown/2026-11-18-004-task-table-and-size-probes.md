# Sort the task table and show file sizes sooner

- Sort the full filtered task list by file, status, progress, size, speed, time remaining, or date added. The file column uses the available space, and transfer values align with their headings.
- See known member sizes when expanding MEGA or MediaFire folders.
- Optionally check unknown file sizes with a background HEAD request for direct HTTP(S) downloads and Telegraph media. The download starts independently, and its reported size takes priority.
- Read fully localized table headings, sort controls, and download speed descriptions in English and Chinese.

## Verification

- Core and API regressions cover task ordering and download admission while a HEAD request is pending. Browser checks cover settings, virtualized rows, and bilingual table and speed labels.
