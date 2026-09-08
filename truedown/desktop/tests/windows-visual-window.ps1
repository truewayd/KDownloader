param(
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$ProcessId,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]+$')][string]$WindowHandle,
    [Parameter(Mandatory = $true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;
public static class TrueDownVisibleWindow {
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct TITLEBARINFOEX {
        public uint size;
        public RECT title;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 6)] public uint[] states;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 6)] public RECT[] rects;
    }
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out RECT rect);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("dwmapi.dll")] private static extern int DwmFlush();
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr SendMessageTimeoutW(IntPtr window, uint message, UIntPtr wparam, IntPtr lparam, uint flags, uint timeout, out IntPtr result);
    public static void Capture(IntPtr window, uint expectedProcess, string path) {
        uint process;
        GetWindowThreadProcessId(window, out process);
        if (process != expectedProcess) throw new InvalidOperationException("Refusing another process's window");
        var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        var foreground = GetForegroundWindow();
        try {
            if (!IsWindowVisible(window)) throw new InvalidOperationException("Show the window through the application before capture");
            // Keep the application's DPI-aware size and show no other window.
            SetWindowPos(window, new IntPtr(-1), 0, 0, 0, 0, 0x0013);
            SetForegroundWindow(window);
            Thread.Sleep(700);
            DwmFlush();
            if (!IsWindowVisible(window)) throw new InvalidOperationException("Window became hidden before capture");
            RECT rect;
            if (!GetWindowRect(window, out rect)) throw new InvalidOperationException("Cannot read window bounds");
            int width = rect.right - rect.left, height = rect.bottom - rect.top;
            if (width < 100 || height < 100 || width > 8192 || height > 8192) throw new InvalidOperationException("Unbounded capture dimensions");
            using (var bitmap = new Bitmap(rect.right - rect.left, rect.bottom - rect.top)) {
                using (var graphics = Graphics.FromImage(bitmap)) {
                    var dc = graphics.GetHdc();
                    try { if (!PrintWindow(window, dc, 2)) throw new InvalidOperationException("Native window capture failed"); }
                    finally { graphics.ReleaseHdc(dc); }
                }
                bitmap.Save(path, ImageFormat.Png);
                var caption = new TITLEBARINFOEX { size = (uint)Marshal.SizeOf(typeof(TITLEBARINFOEX)), states = new uint[6], rects = new RECT[6] };
                var memory = Marshal.AllocHGlobal((int)caption.size);
                try {
                    Marshal.StructureToPtr(caption, memory, false);
                    IntPtr result;
                    if (SendMessageTimeoutW(window, 0x033f, UIntPtr.Zero, memory, 2, 1000, out result) == IntPtr.Zero) throw new InvalidOperationException("Cannot read caption geometry");
                    caption = (TITLEBARINFOEX)Marshal.PtrToStructure(memory, typeof(TITLEBARINFOEX));
                    int radius = (int)Math.Ceiling(8.0 * GetDpiForWindow(window) / 96);
                    foreach (var index in new int[] { 2, 3, 5 }) {
                        var button = caption.rects[index];
                        int x = (button.left + button.right) / 2 - rect.left, y = (button.top + button.bottom) / 2 - rect.top;
                        if (button.right <= button.left || x - radius < 0 || y - radius < 0 || x + radius >= width || y + radius >= height) throw new InvalidOperationException("Caption button outside capture");
                        int darkest = 255, lightest = 0;
                        for (int py = y - radius; py <= y + radius; py++) for (int px = x - radius; px <= x + radius; px++) {
                            var color = bitmap.GetPixel(px, py);
                            int value = (color.R + color.G + color.B) / 3;
                            darkest = Math.Min(darkest, value); lightest = Math.Max(lightest, value);
                        }
                        if (lightest - darkest < 35) throw new InvalidOperationException("Missing visible caption glyph " + index);
                    }
                } finally { Marshal.FreeHGlobal(memory); }
            }
            Console.WriteLine("native_caption_glyphs=ok");
        } finally {
            ShowWindow(window, 0);
            SetWindowPos(window, new IntPtr(-2), 0, 0, 0, 0, 0x0013);
            if (foreground != IntPtr.Zero) SetForegroundWindow(foreground);
            if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous);
        }
    }
}
'@
[TrueDownVisibleWindow]::Capture([IntPtr]::new([Convert]::ToInt64($WindowHandle, 16)), [uint32]$ProcessId, $OutputPath)
