# Native display fitting and platform validation

- Fit native windows to the display work area using physical frame dimensions;
  shrink minimum sizes on small/high-scale displays and refit after DPI changes.
- Keep the Windows tray's matching DPI rasters and supply enough macOS status
  icon pixels for Retina. Honor macOS native reduced-transparency/high-contrast
  preferences and isolate WKWebView website stores by profile.
- Generate Linux's PNG icon from the canonical ICO during native preparation.
- Add hidden WebKitGTK acceptance and a Windows/Linux/macOS native CI matrix.

## Verification

Windows Rust formatting, clippy and eight tests pass. Windows hidden
WebView2 acceptance confirms all four windows fit their display and stay hidden,
including core/shell crash cleanup. Linux native build, clippy, unit tests and
hidden WebKitGTK window/settings acceptance pass. macOS runtime remains untested
locally; its target-specific compilation is included in CI.
