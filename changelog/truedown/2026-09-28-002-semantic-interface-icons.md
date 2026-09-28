# TrueDown interface icon clarity

- Replace character-based select checkmarks and advanced-option plus/minus indicators with generated Lucide SVG icons.
- Distinguish New download, Add group, Edit group and Manage groups with download, folder-plus, folder-pen and folders icons across native menus and their matching controls.
- Give the tray Open action an application-window icon on Windows, macOS and Linux, separate from New download.
- Use purpose-specific settings navigation icons for speed, application, engine, advanced parameters and experiments, and a separate reset icon for restoring defaults.
- Verify that Windows menu rasters and other desktop menu SVGs use the same source shapes and that adjacent operations remain visually distinct.
- Keep debug-only native menu geometry fields out of release builds to eliminate unused-field warnings.

## Verification

- Generated icon consistency, cross-platform menu mappings and native raster dimensions.
- Light/dark select and new-task form browser acceptance, including keyboard navigation and disabled options.
- Repository tests, Go tests/vet, Rust tests and native release build validation.
