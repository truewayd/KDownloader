# TrueDown 1.6.3 - Dependency repairs and caption-safe notifications

- Backport the GLib VariantStrIter memory-safety fix for the GTK3 dependency
  stack. Replace the unmaintained macro and five UNIC dependencies while
  preserving Syn 2 and URLPattern ID_Start/ID_Continue behavior.
- Keep exact original archive provenance, complete patched-source hashes and
  license notices. Native builds reject changed patch trees; local dependencies
  remain included in vulnerability scans and packaged license inventories.
- Center Toast notifications at the top, 16px below the native title strip or
  safe-area inset. Bound and wrap long messages in compact and high-DPI windows,
  with an entrance animation that preserves horizontal centering.
- Bring the Linux native acceptance fixture up to date with inherited resolver
  preferences and verify Toast visibility before measuring it.

## Verification

- Node regression suite, source-tamper checks, Rust formatting/Clippy/tests and
  the Windows native build and hidden WebView2 acceptance.
- Real Chromium checks for main/settings/task-form Toasts, light/dark themes,
  100%/200% scale, mobile widths, and Windows/macOS/Linux title-strip layouts.
- Linux Tauri build and real WebKitGTK acceptance inside WSL/Xvfb. GLib's FFI
  regression is also exercised with release optimization.
- Final OSV scan covers all 515 locked packages including local patches. The
  six maintenance notices are removed; the remaining version-based GLib advisory
  corresponds to the checked backport. No global advisory suppression is used.
- Windows amd64 package startup, matched shell/core/CLI identity and archive
  verification. Product version remains 1.6.3; this is a local development build.
- macOS native compilation/composition is not verified on this Windows host.
