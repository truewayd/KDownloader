param([int]$ProcessId, [string]$Title, [string]$OutputPath, [switch]$Server,
  [ValidatePattern('^[0-9a-f]+$')][string]$WindowHandle,
  [switch]$Hover, [double]$HoverX, [double]$HoverY, [string]$ReleaseHoverPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class PopupCapture {
  delegate bool Callback(IntPtr window, IntPtr data);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int left, top, right, bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder title, int count);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
  [DllImport("dwmapi.dll")] static extern int DwmFlush();
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref POINT point);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr window, int index);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int count);
  [StructLayout(LayoutKind.Sequential)] struct MENUBARINFO { public uint size; public RECT rect; public IntPtr menu, window; public uint flags; }
  [StructLayout(LayoutKind.Sequential)] struct GUIINFO { public uint size, flags; public IntPtr active, focus, capture, menuOwner, moveSize, caret; public RECT rect; }
  [DllImport("user32.dll")] static extern bool GetMenuBarInfo(IntPtr window, int objectId, int item, ref MENUBARINFO info);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GUIINFO info);
  [DllImport("user32.dll")] static extern int GetMenuItemCount(IntPtr menu);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetMenuString(IntPtr menu, uint item, StringBuilder text, int count, uint flags);
  [DllImport("user32.dll")] static extern bool GetMenuItemRect(IntPtr window, IntPtr menu, uint item, out RECT rect);
  [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  static IntPtr MenuOwner(IntPtr popup) {
    uint process;
    var thread = GetWindowThreadProcessId(popup, out process);
    var name = new StringBuilder(128); GetClassName(popup, name, name.Capacity);
    if (name.ToString() == "TrueDown.CompositionMenu.v1") {
      var owner = GetWindow(popup, 4);
      uint ownerProcess; GetWindowThreadProcessId(owner, out ownerProcess);
      if (owner == IntPtr.Zero || ownerProcess != process || GetForegroundWindow() != owner)
        throw new Exception("Composition menu caller lost foreground");
      return owner;
    }
    var info = new GUIINFO { size = (uint)Marshal.SizeOf(typeof(GUIINFO)) };
    if (!GetGUIThreadInfo(thread, ref info) || info.menuOwner == IntPtr.Zero) throw new Exception("Menu owner unavailable");
    GetWindowThreadProcessId(info.menuOwner, out thread);
    if (thread != process || GetForegroundWindow() != info.menuOwner) throw new Exception("Menu caller lost foreground");
    return info.menuOwner;
  }
  public static string NativeMenu(uint process, string label, string key, int itemCount, double itemOffset) {
    var popup = Find(process, "#32768");
    MenuOwner(popup);
    if (!String.IsNullOrEmpty(key)) {
      byte code = key == "Escape" ? (byte)27 : key == "End" ? (byte)35 : key == "Enter" ? (byte)13 : (byte)0;
      if (code == 0) throw new Exception("Unsupported menu key");
      keybd_event(code, 0, 0, UIntPtr.Zero); keybd_event(code, 0, 2, UIntPtr.Zero);
      return "{\"sent\":true}";
    }
    var name = new StringBuilder(128); GetClassName(popup, name, name.Capacity);
    if (name.ToString() == "TrueDown.CompositionMenu.v1") {
      if (String.IsNullOrEmpty(label)) return "{\"visible\":true,\"ownerForeground\":true,\"renderer\":\"composition\"}";
      if (itemCount < 1 || itemCount > 32 || Double.IsNaN(itemOffset) || Double.IsInfinity(itemOffset) || itemOffset <= 0)
        throw new Exception("Composition menu requires a bounded offered item");
      var previousContext = SetThreadDpiAwarenessContext(new IntPtr(-4));
      try {
        RECT rect;
        if (!GetClientRect(popup, out rect)) throw new Exception("Composition menu bounds unavailable");
        var point = new POINT { x = rect.right / 2, y = (int)Math.Round(itemOffset * GetDpiForWindow(popup) / 96.0) };
        if (point.y >= rect.bottom || !ClientToScreen(popup, ref point) || WindowFromPoint(point) != popup)
          throw new Exception("Composition menu item is outside or covered");
        if (!SetCursorPos(point.x, point.y)) throw new Exception("Menu item position unavailable");
        mouse_event(2, 0, 0, 0, UIntPtr.Zero); mouse_event(4, 0, 0, 0, UIntPtr.Zero);
        return "{\"clicked\":true}";
      } finally { if (previousContext != IntPtr.Zero) SetThreadDpiAwarenessContext(previousContext); }
    }
    var info = new MENUBARINFO { size = (uint)Marshal.SizeOf(typeof(MENUBARINFO)) };
    if (!GetMenuBarInfo(popup, -4, 0, ref info) || info.menu == IntPtr.Zero) throw new Exception("Native menu unavailable");
    int count = GetMenuItemCount(info.menu);
    if (String.IsNullOrEmpty(label)) return "{\"visible\":true,\"ownerForeground\":true,\"count\":" + count + "}";
    var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
    try {
      for (uint index = 0; index < count; index++) {
        var text = new StringBuilder(512); GetMenuString(info.menu, index, text, text.Capacity, 0x400);
        if (text.ToString().Split('\t')[0] != label) continue;
        RECT rect;
        if (!GetMenuItemRect(IntPtr.Zero, info.menu, index, out rect)) throw new Exception("Menu item bounds unavailable");
        var point = new POINT { x = (rect.left + rect.right) / 2, y = (rect.top + rect.bottom) / 2 };
        if (WindowFromPoint(point) != popup) throw new Exception("Menu item covered");
        if (!SetCursorPos(point.x, point.y)) throw new Exception("Menu item position unavailable");
        mouse_event(2, 0, 0, 0, UIntPtr.Zero); mouse_event(4, 0, 0, 0, UIntPtr.Zero);
        return "{\"clicked\":true}";
      }
      throw new Exception("Offered menu action not found: " + label);
    } finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
  }
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  public static string HoverStart(uint process, long handle, double x, double y) {
    var window = new IntPtr(handle);
    uint owner; GetWindowThreadProcessId(window, out owner);
    if (owner != process) throw new Exception("Hover HWND no longer belongs to the fixture");
    if (!IsWindowVisible(window)) throw new Exception("Hover window became hidden");
    if (GetForegroundWindow() == window) throw new Exception("Hover window became active");
    var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
    try {
      var scale = GetDpiForWindow(window) / 96.0;
      var point = new POINT { x = (int)Math.Round(x * scale), y = (int)Math.Round(y * scale) };
      RECT rect; POINT cursor;
      if (!GetClientRect(window, out rect) || point.x < 0 || point.y < 0 || point.x >= rect.right || point.y >= rect.bottom
        || !ClientToScreen(window, ref point) || !GetCursorPos(out cursor)) throw new Exception("Hover position unavailable");
      bool topmost = (GetWindowLongW(window, -20) & 8) != 0;
      // Expose only this fixture without changing keyboard activation.
      if (!SetWindowPos(window, new IntPtr(-1), 0, 0, 0, 0, 0x0013)) throw new Exception("Hover placement failed");
      // Escape may dismiss a tooltip while the mouse is still inside its anchor.
      // Leave that anchor first so the next native hover gets a fresh enter.
      var neutral = new POINT { x = 8, y = 8 };
      if (ClientToScreen(window, ref neutral)) SetCursorPos(neutral.x, neutral.y);
      System.Threading.Thread.Sleep(50);
      if (GetAncestor(WindowFromPoint(point), 2) != window || !SetCursorPos(point.x, point.y)) {
        SetWindowPos(window, new IntPtr(topmost ? -1 : -2), 0, 0, 0, 0, 0x0013);
        throw new Exception("Owned hover target is covered");
      }
      return "{\"topmost\":" + (topmost ? "true" : "false") + ",\"originalX\":" + cursor.x + ",\"originalY\":" + cursor.y + ",\"targetX\":" + point.x + ",\"targetY\":" + point.y + "}";
    } finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
  }
  public static void HoverEnd(uint process, long handle, bool topmost, int originalX, int originalY, int targetX, int targetY) {
    var window = new IntPtr(handle);
    uint owner; GetWindowThreadProcessId(window, out owner);
    if (owner != process) return;
    var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
    try {
      POINT cursor;
      if (GetCursorPos(out cursor) && cursor.x == targetX && cursor.y == targetY) SetCursorPos(originalX, originalY);
      SetWindowPos(window, new IntPtr(topmost ? -1 : -2), 0, 0, 0, 0, 0x0013);
    } finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
  }
  public static string Click(uint process, string title, double x, double y) {
    var found = Find(process, title);
    var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
    try {
      var scale = GetDpiForWindow(found) / 96.0;
      var point = new POINT { x = (int)Math.Round(x * scale), y = (int)Math.Round(y * scale) };
      RECT rect;
      if (!GetClientRect(found, out rect) || point.x < 0 || point.y < 0 || point.x >= rect.right || point.y >= rect.bottom)
        throw new Exception("Click must stay inside the owned window");
      if (!ClientToScreen(found, ref point)) throw new Exception("Click position unavailable");
      if (GetAncestor(WindowFromPoint(point), 2) != found) throw new Exception("Owned click target is covered by another window");
      if (!SetCursorPos(point.x, point.y)) throw new Exception("Click position unavailable");
      mouse_event(2, 0, 0, 0, UIntPtr.Zero);
      mouse_event(4, 0, 0, 0, UIntPtr.Zero);
      System.Threading.Thread.Sleep(100);
      return "{\"clicked\":true}";
    } finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
  }
  static IntPtr Find(uint process, string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((window, data) => {
      uint owner; GetWindowThreadProcessId(window, out owner);
      var text = new StringBuilder(512); GetWindowText(window, text, text.Capacity);
      if (title == "#32768") GetClassName(window, text, text.Capacity);
      if (owner == process && (text.ToString() == title || (title == "#32768" && text.ToString() == "TrueDown.CompositionMenu.v1")) && IsWindowVisible(window)) found = window;
      return true;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) throw new Exception("Owned visible popup not found");
    return found;
  }
  public static string Capture(uint process, string title, string path, long windowHandle = 0, bool screen = false) {
    var found = windowHandle == 0 ? Find(process, title) : new IntPtr(windowHandle);
    uint ownerProcess; GetWindowThreadProcessId(found, out ownerProcess);
    if (ownerProcess != process || !IsWindowVisible(found)) throw new Exception("Owned visible window unavailable");
    if (String.IsNullOrEmpty(path)) {
      var nativeClass = new StringBuilder(512); GetClassName(found, nativeClass, nativeClass.Capacity);
      var nativeTitle = new StringBuilder(512); GetWindowText(found, nativeTitle, nativeTitle.Capacity);
      if (nativeTitle.ToString() == "操作菜单" || nativeClass.ToString() == "#32768" || nativeClass.ToString() == "TrueDown.CompositionMenu.v1") throw new Exception("Do not activate mouse menu windows");
      if (GetForegroundWindow() != found && !SetForegroundWindow(found)) {
        throw new Exception("Owned window could not receive foreground focus");
      }
      return "{\"focused\":true}";
    }
    var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
    try {
      DwmFlush();
      RECT rect; if (!GetWindowRect(found, out rect)) throw new Exception("Window geometry unavailable");
      if (screen && (GetWindowLongW(found, -20) & 8) == 0) throw new Exception("Screen capture requires the exposed owned fixture");
      using (var bitmap = new Bitmap(rect.right-rect.left, rect.bottom-rect.top)) {
        using (var graphics = Graphics.FromImage(bitmap)) {
          if (screen) graphics.CopyFromScreen(rect.left, rect.top, 0, 0, bitmap.Size, CopyPixelOperation.SourceCopy);
          else {
            var dc = graphics.GetHdc();
            try { if (!PrintWindow(found, dc, 2)) throw new Exception("Window capture failed"); }
            finally { graphics.ReleaseHdc(dc); }
          }
        }
        bitmap.Save(path, ImageFormat.Png);
      }
      var parent = GetWindow(found, 4);
      if (title == "#32768") parent = MenuOwner(found);
      POINT cursor; GetCursorPos(out cursor);
      return "{\"handle\":\"" + found.ToInt64().ToString("x") + "\",\"owner\":\"" + parent.ToInt64().ToString("x") + "\",\"ownerEnabled\":" + (IsWindowEnabled(parent) ? "true" : "false") + ",\"ownerForeground\":" + (GetForegroundWindow() == parent ? "true" : "false") + ",\"cursorX\":" + cursor.x + ",\"cursorY\":" + cursor.y + "}";
    } finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
  }
}
'@
if ($Server) {
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  [Console]::WriteLine('ready')
  while ($null -ne ($line = [Console]::ReadLine())) {
    try {
      $request = $line | ConvertFrom-Json
      if ($null -ne $request.hover) {
        [Console]::WriteLine([PopupCapture]::HoverStart([uint32]$request.processId, [Convert]::ToInt64($request.windowHandle, 16), [double]$request.hover.x, [double]$request.hover.y))
      } elseif ($null -ne $request.releaseHover) {
        $hoverState = $request.releaseHover
        [PopupCapture]::HoverEnd([uint32]$request.processId, [Convert]::ToInt64($hoverState.windowHandle, 16), [bool]$hoverState.topmost,
          [int]$hoverState.originalX, [int]$hoverState.originalY, [int]$hoverState.targetX, [int]$hoverState.targetY)
        [Console]::WriteLine('{"released":true}')
      } elseif ($null -ne $request.nativeMenu) {
        [Console]::WriteLine([PopupCapture]::NativeMenu([uint32]$request.processId, [string]$request.nativeMenu.label, [string]$request.nativeMenu.key, [int]$request.nativeMenu.itemCount, [double]$request.nativeMenu.itemOffset))
      } elseif ($null -ne $request.point) {
        [Console]::WriteLine([PopupCapture]::Click([uint32]$request.processId, [string]$request.title, [double]$request.point.x, [double]$request.point.y))
      } else {
        $requestHandle = if ($request.windowHandle) { [Convert]::ToInt64($request.windowHandle, 16) } else { 0 }
        [Console]::WriteLine([PopupCapture]::Capture([uint32]$request.processId, [string]$request.title, [string]$request.path, $requestHandle, [bool]$request.screen))
      }
    } catch { [Console]::WriteLine((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress)) }
  }
} else {
  $captureHandle = if ($WindowHandle) { [Convert]::ToInt64($WindowHandle, 16) } else { 0 }
  if ($ReleaseHoverPath) {
    $hoverState = Get-Content -Raw -LiteralPath $ReleaseHoverPath | ConvertFrom-Json
    [PopupCapture]::HoverEnd([uint32]$ProcessId, [Convert]::ToInt64($hoverState.windowHandle, 16), [bool]$hoverState.topmost,
      [int]$hoverState.originalX, [int]$hoverState.originalY, [int]$hoverState.targetX, [int]$hoverState.targetY)
  } elseif ($Hover) {
    [PopupCapture]::HoverStart([uint32]$ProcessId, $captureHandle, $HoverX, $HoverY)
  } else {
    [PopupCapture]::Capture([uint32]$ProcessId, $Title, $OutputPath, $captureHandle)
  }
}
