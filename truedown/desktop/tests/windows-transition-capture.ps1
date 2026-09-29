param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]+$')][string]$WindowHandle,
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
public static class TrueDownTransitionCapture {
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int left, top, right, bottom; }
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  public static void Capture(IntPtr hwnd, uint expectedPid, string directory) {
    uint pid; GetWindowThreadProcessId(hwnd, out pid);
    if (pid != expectedPid) throw new InvalidOperationException("Foreign capture window");
    var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
    var frames = new Bitmap[72];
    var times = new long[frames.Length];
    try {
      RECT rect;
      if (!GetWindowRect(hwnd, out rect)) throw new InvalidOperationException("Missing capture window");
      int width = rect.right - rect.left, height = rect.bottom - rect.top;
      if (width < 1 || height < 1 || width > 2400 || height > 1800) throw new InvalidOperationException("Invalid capture bounds");
      // A bounded crop keeps screen readback below a full high-DPI frame.
      rect.left += Math.Max(0, (width - 600) / 2);
      width = Math.Min(width, 600); height = Math.Min(height, 420);
      Directory.CreateDirectory(directory);
      for (int i = 0; i < frames.Length; i++) frames[i] = new Bitmap(width, height, PixelFormat.Format32bppRgb);
      Console.WriteLine("ready"); Console.Out.Flush();
      var clock = Stopwatch.StartNew();
      for (int i = 0; i < frames.Length; i++) {
        times[i] = clock.ElapsedMilliseconds;
        using (var graphics = Graphics.FromImage(frames[i])) {
          graphics.CopyFromScreen(rect.left, rect.top, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
        }
        int wait = (i + 1) * 16 - (int)clock.ElapsedMilliseconds;
        if (wait > 0) Thread.Sleep(wait);
      }
      for (int i = 0; i < frames.Length; i++) frames[i].Save(Path.Combine(directory, i.ToString("D2") + ".png"), ImageFormat.Png);
      File.WriteAllText(Path.Combine(directory, "times.json"), "[" + String.Join(",", times) + "]");
      Console.WriteLine("captured");
    } finally {
      foreach (var frame in frames) if (frame != null) frame.Dispose();
      if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous);
    }
  }
}
'@
[TrueDownTransitionCapture]::Capture([IntPtr]::new([Convert]::ToInt64($WindowHandle, 16)), [uint32]$ProcessId, $OutputDirectory)
