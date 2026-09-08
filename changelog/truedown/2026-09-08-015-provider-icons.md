# Consistent provider icons

Google Drive and Dropbox gain original stroke-based provider marks that match
the shared 24px icon grid. The sources are tracked in `truedown/tools/icons/`
and listed alongside the pinned Lucide icons in the canonical source manifest.
The existing generator includes them in the TrueDown SVG sprite and verifies
that generated assets stay current.

Icon generation checks and the icon asset regression tests pass. Extension
icons and native brand rasters remain byte-for-byte unchanged.
