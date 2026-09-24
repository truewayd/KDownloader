# TrueDown: stable menu framing, rightward placement and Acrylic

- Preserve the native nonclient layout policy instead of forcing DWM frame
  rendering during menu creation; disable slide animation so the painted menu
  and native hit regions do not move independently during opening.
- Prefer rightward opening using a top-left anchor and native work-area fitting.
  Remove the inherited left-opening alignment override. Native placement can
  shift menus left/up when they would otherwise leave the monitor work area.
- Enable the Windows 11 transient Acrylic backdrop with premultiplied alpha
  rendering for text, generated icons and rounded hover surfaces. Native item
  rectangles and selection state drive both opaque and translucent rendering.
- Honor system transparency/high-contrast settings and fall back to opaque
  rendering on unsupported APIs or buffer allocation failure. Bound temporary
  buffers and release GDI resources on every path.
- Keep shortcut space separate from labels and use grayscale text antialiasing
  that is valid on both opaque and translucent backgrounds.

## Verification

- Windows debug build and test-target compilation succeed. No tests were run.
- Interactive acceptance is delegated to the user: hover/click alignment,
  monitor-edge placement, light/dark Acrylic and transparency-off fallback.
- Reference: Chromium's MenuController prefers an anchor direction, flips or
  clamps bounds when needed, and confines menus to monitor bounds:
  https://github.com/chromium/chromium/blob/main/ui/views/controls/menu/menu_controller.cc
- Acrylic uses the documented DWMSBT_TRANSIENTWINDOW backdrop on Windows 11:
  https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwm_systembackdrop_type
