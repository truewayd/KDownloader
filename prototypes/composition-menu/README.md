# Independent native Composition menu prototype

This executable is separate from TrueDown. It does not install shell extensions,
change TrueDown menus, connect to its core, or perform download/clipboard actions.
All actions are synthetic. Windows 11 is required. Menu items use native
Direct2D/DirectWrite textures with Windows Composition; there is no WebView,
HTML, JavaScript, browser profile or downloaded runtime.

## Material and scope

The default is **Composition background blur with an Acrylic-style tint**:
HostBackdropBrush samples content behind the window, with a neutral color layer
above it. This is not the full system DesktopAcrylicController material recipe.
Both themes now use tint alpha 184/255 (about 72%), reduced from 208/255,
to expose more of the blurred backdrop. Text remains opaque and cached; hover
and selection remain translucent. Actual readability and appearance need manual
acceptance.

The surface has a 16 DIP outer radius and 10 DIP selection radius, following
the TrueDown product baseline. Rows are 32 DIP high with 5 DIP outer gutters;
the 272 DIP width is retained and height is now 179 DIP. A subtle one-physical-pixel
rounded border (dark in light theme, light in dark theme) separates the material
from its backdrop. Border and separator strokes are aligned to pixel centers at
the current DPI and cached with the text. They do not fill or obscure the blurred
interior. The existing soft Composition shadow remains outside the surface.

The Mica investigation is discontinued by user decision. Mica switching, custom
caption/frame changes, synthetic nonclient activation and F6 tree-detachment
diagnostics have been removed. Earlier Mica-only integration guidance is superseded.
The old F6 observation did not establish that the content tree was detached:
there was no successful-detachment log, and the key could silently do nothing.

The menu keeps one nonactivating WS_POPUP with WS_EX_TOOLWINDOW and
WS_EX_NOREDIRECTIONBITMAP. No system backdrop or full-client frame extension is
applied. Rounded clipping and shadow belong to the Composition tree. Disabling
Windows transparency, or selecting the solid override, hides the backdrop brush
and makes the tint opaque. Full high-contrast and screen-reader acceptance remains
outstanding. No TrueDown integration is performed or authorized by this update.

## Manual use

Open **Composition Menu Prototype** from the Start menu and right-click inside
its checkerboard window. F2 switches light/dark. F3 switches blur/solid.
The title shows the material and theme. F4 and F6 have no assigned action.

Escape dismisses the menu. Arrow keys, Home/End and Enter select a synthetic
action; Shift+F10 opens it from the keyboard. Clicking outside, scrolling,
resizing or deactivating the owner dismisses it. An outside right-button press
hides the old menu; release opens a new session. Reopening hides the old surface
before repositioning, and stale deferred actions cannot close a newer menu.
Closing the background window exits the prototype.

The visible menu corner follows the native WM_CONTEXTMENU coordinate. Its 16 DIP
shadow padding extends outside that anchor. Work-area fitting constrains the
visible surface, with DPI layout settled before showing. Transparent shadow and
corner areas do not intercept input. Title-bar clicks retain the owner's system menu.

## Rendering and performance

The design borrows EarPan's Composition backdrop, tint, clipping and shadow
separation. Text and icons use Microsoft YaHei UI and Segoe MDL2 Assets through DirectWrite,
rasterized into transparent premultiplied BGRA surfaces by Direct2D.
This is a custom native popup, not Win32 HMENU.

Devices, visual tree and text layouts are created once. Both light/dark textures
and their surface brushes are prepared together per DPI (or diagnostic-marker
change). This uses two small cached surfaces to move rasterization out of the
first theme switch. Unchanged appearance is skipped. Pointer and keyboard selection only move/show a Composition
selection visual; they do not rerasterize text. Theme changes update brushes and
select a cached texture without renewing the native shell. Ordinary reopen
reuses resources. Placement compares the actual HWND rectangle and skips
geometry writes if position and size are unchanged; pure moves use SWP_NOSIZE.
Opening separately renews the popup's topmost position without activating it.
Hide still precedes relocation and DPI settles before show. Mouse-leave tracking
is cancelled on dismissal. There is no idle timer, frame loop, screenshot blur, application
animation or browser process. Per-window DWM transitions remain disabled.
D3D11 uses hardware. TrueDown falls back to HMENU when native graphics are
unavailable; the independent prototype reports the initialization error.

No latency, CPU/GPU, black-frame or visual acceptance is claimed for this revision.
A full UI Automation menu provider and device-loss reconstruction remain outside
this prototype.

## Build and installation

Use build.ps1 with the existing Cargo toolchain and locked offline dependencies.
The stable target/ directory is reusable. install.ps1 -RecordDirectory <path>
copies the executable and guide to %LOCALAPPDATA%/Programs/CompositionMenuPrototype,
checks the copied hash and updates the Start menu shortcut. It does not launch
the application, create autostart or install a service.

## Optional diagnostics

Only user-initiated F5 or --auto starts the cycle diagnostic. F5 runs 120 cycles;
Escape stops it. --cycles N changes the count, --sample enables bounded sampling
of the synthetic owner's area, and --exit exits afterwards. measure.ps1 is a
separate opt-in recorder. These diagnostics were not run by the agent.

Current CSV files record the requested solid override and effective solid state.
Older runs have a different schema including Mica; use each file's own header.
Sampling can miss frames and has overhead. The detector flags more than 1%
near-black interior pixels; call_ms measures API work, not display latency.
The old WebView revision's cycle results do not validate this native revision.

Normal launch writes small records under
%LOCALAPPDATA%/CompositionMenuPrototype/work/runs/<time>-<pid>-native/ with a
14-day manifest. --data-dir <absolute-path> can redirect these records.
Expiration is a cleanup candidate, not automatic deletion. Old profiles, logs
and rollback installers are preserved.

References: EarPan crates/composition-host/src/lib.rs;
[HostBackdropBrush](https://learn.microsoft.com/en-us/uwp/api/windows.ui.composition.compositor.createhostbackdropbrush);
[Composition drawing surfaces](https://learn.microsoft.com/en-us/windows/win32/api/windows.ui.composition.interop/nf-windows-ui-composition-interop-icompositiondrawingsurfaceinterop-begindraw).
[Windows geometry](https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/geometry).


原生文字、图标和边框渲染现与 TrueDown 共用 truedown/native-menu；独立窗口仍仅执行演示动作。TrueDown 已接入同一绘制路径，托盘和内容菜单统一样式。

Popup stacking is renewed on every opening with HWND_TOPMOST and no activation. Closing hides, detaches and demotes the popup without changing the owner’s pinned state. Palette and shadow tokens share native-menu/src/style.rs with TrueDown.
