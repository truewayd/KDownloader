# Toolbar icon scale

- Reduce transparent padding around the existing KDownloader artwork when
  exporting browser icons, preserving its shape, colors and aspect ratio.
- Supply explicit 16, 20, 24, 32 and 48 pixel toolbar icons and regenerate the
  128 pixel extension icon directly from the canonical vector source.
- Include extension logo exports in the root icons:sync and icons:check commands.

## Verification

- Icon generation consistency, alpha-bound measurements and visual inspection.
- Shared UI consistency, Node suite and Python history migration tests.
- Clean extension build with byte-identical staged icon assets.
- Live Chrome toolbar appearance still requires reloading the extension.
