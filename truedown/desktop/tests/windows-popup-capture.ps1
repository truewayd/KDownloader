param([Parameter(Mandatory=$true)][int]$ProcessId, [Parameter(Mandatory=$true)][string]$Title, [Parameter(Mandatory=$true)][string]$OutputPath)
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
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  public static string Capture(uint process, string title, string path) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((window, data) => {
      uint owner; GetWindowThreadProcessId(window, out owner);
      var text = new StringBuilder(512); GetWindowText(window, text, text.Capacity);
      if (owner == process && text.ToString() == title && IsWindowVisible(window)) found = window;
      return true;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) throw new Exception("Owned visible popup not found");
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
      return "{\"handle\":\"" + found.ToInt64().ToString("x") + "\",\"owner\":\"" + parent.ToInt64().ToString("x") + "\",\"ownerEnabled\":" + (IsWindowEnabled(parent) ? "true" : "false") + "}";
    } finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
  }
}
'@
[PopupCapture]::Capture([uint32]$ProcessId, $Title, $OutputPath)
