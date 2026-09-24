param([int]$ProcessId, [string]$Title, [string]$OutputPath, [switch]$Server)
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
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref POINT point);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
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
      if (owner == process && text.ToString() == title && IsWindowVisible(window)) found = window;
      return true;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) throw new Exception("Owned visible popup not found");
    return found;
  }
  public static string Capture(uint process, string title, string path) {
    var found = Find(process, title);
    if (String.IsNullOrEmpty(path)) {
      if (title == "操作菜单") throw new Exception("Do not activate mouse menu windows");
      if (GetForegroundWindow() != found && !SetForegroundWindow(found)) {
        throw new Exception("Owned window could not receive foreground focus");
      }
      return "{\"focused\":true}";
    }
    var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
    try {
      RECT rect; if (!GetWindowRect(found, out rect)) throw new Exception("Window geometry unavailable");
      using (var bitmap = new Bitmap(rect.right-rect.left, rect.bottom-rect.top)) {
        using (var graphics = Graphics.FromImage(bitmap)) {
          var dc = graphics.GetHdc();
          try { if (!PrintWindow(found, dc, 2)) throw new Exception("Window capture failed"); }
          finally { graphics.ReleaseHdc(dc); }
        }
        bitmap.Save(path, ImageFormat.Png);
      }
      var parent = GetWindow(found, 4);
      return "{\"handle\":\"" + found.ToInt64().ToString("x") + "\",\"owner\":\"" + parent.ToInt64().ToString("x") + "\",\"ownerEnabled\":" + (IsWindowEnabled(parent) ? "true" : "false") + ",\"ownerForeground\":" + (GetForegroundWindow() == parent ? "true" : "false") + "}";
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
      if ($null -ne $request.point) {
        [Console]::WriteLine([PopupCapture]::Click([uint32]$request.processId, [string]$request.title, [double]$request.point.x, [double]$request.point.y))
      } else {
        [Console]::WriteLine([PopupCapture]::Capture([uint32]$request.processId, [string]$request.title, [string]$request.path))
      }
    } catch { [Console]::WriteLine((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress)) }
  }
} else { [PopupCapture]::Capture([uint32]$ProcessId, $Title, $OutputPath) }
