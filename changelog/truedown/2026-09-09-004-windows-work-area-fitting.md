# TrueDown - Windows work-area fitting

- Fix settings and other native windows extending below small monitor work areas.
  The custom caption extends the client area, while Tao's sizing APIs still add
  the standard caption inset. Measure and compensate for that difference in
  both client sizes and minimum-size constraints instead of adding a fixed margin.
- Restore the intended size after changing minimums, since Tao also resizes the
  window in that operation. Repeated fitting no longer grows the window. Run
  measurement and fitting on the UI thread and preserve maximized/minimized state.
- Make hidden Windows acceptance exercise a 1024x720 physical work area even on
  larger developer monitors. The override requires the debug suppression switch,
  is absent from release builds and does not change desktop resolution.
- Report outer bounds, WebView viewport/scale and monitor work areas on failures.
  Add a real hidden HWND regression for standard-caption overflow and repeated
  fitting to 1024x720 and 640x360 work areas. Product version remains 1.6.3.

## Verification

- Windows hidden HWND regression reproduces the old caption overflow and checks
  repeated fitting at 1024x720 and 640x360. Rust formatting, Clippy and all 27
  Windows Rust tests pass.
- Windows debug build, full hidden WebView2 acceptance within the capped work
  areas, shell/core crash cleanup and debug package startup pass.
- Windows release build and hidden package startup pass. Binary inspection
  confirms the small-work-area override is present only in the debug build.
- Linux Rust tests and rebuilt native WebKitGTK acceptance inside Xvfb pass.
- Full Node suite (315 tests), Python migration suite (13 tests), shared UI and
  icon checks, extension build, Go tests/vet, WSL integration and core smoke pass.
- macOS, mixed-DPI monitor moves and visible caption composition were not rerun
  locally. Remote CI has not been rerun.
