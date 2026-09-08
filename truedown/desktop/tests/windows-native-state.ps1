param([Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$ProcessId)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public sealed class TrueDownWindowState {
    public string handle;
    public string title;
    public bool visible;
    public bool caption;
    public bool resizable;
    public bool minimizable;
    public bool maximizable;
    public int clientTopInset;
    public int[] captionHits;
    public bool captionExcludedFromWebView;
    public int dpi;
    public int iconWidth;
    public int iconHeight;
    public int darkResult;
    public int dark;
    public int backdropResult;
    public int backdrop;
    public int legacyMicaResult;
    public int legacyMica;
}

public static class TrueDownNativeState {
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ICONINFO { public bool isIcon; public uint xHotspot, yHotspot; public IntPtr mask, color; }
    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAP { public int type, width, height, widthBytes; public ushort planes, bitsPixel; public IntPtr bits; }
    private delegate bool EnumWindow(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindow callback, IntPtr parameter);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder title, int length);
    [DllImport("user32.dll")]
    private static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr window, out RECT rectangle);
    [DllImport("user32.dll")]
    private static extern bool ClientToScreen(IntPtr window, ref POINT point);
    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr awareness);
    [DllImport("user32.dll")]
    private static extern IntPtr SendMessageTimeoutW(IntPtr window, uint message, UIntPtr wparam, IntPtr lparam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")]
    private static extern bool GetIconInfo(IntPtr icon, out ICONINFO information);
    [DllImport("gdi32.dll")]
    private static extern int GetObjectW(IntPtr value, int size, out BITMAP bitmap);
    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr value);
    [StructLayout(LayoutKind.Sequential)]
    private struct TITLEBARINFOEX {
        public uint size;
        public RECT title;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 6)] public uint[] states;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 6)] public RECT[] rects;
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string className, string title);
    [DllImport("user32.dll")]
    private static extern bool ScreenToClient(IntPtr window, ref POINT point);
    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
    [DllImport("user32.dll")]
    private static extern int GetWindowRgn(IntPtr window, IntPtr region);
    [DllImport("gdi32.dll")]
    private static extern bool PtInRegion(IntPtr region, int x, int y);
    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);

    public static TrueDownWindowState[] Read(uint processId) {
        // Match the app's physical coordinate space across mixed-DPI monitors.
        var previousAwareness = SetThreadDpiAwarenessContext(new IntPtr(-4));
        var states = new List<TrueDownWindowState>();
        try { EnumWindows((window, parameter) => {
            uint process;
            GetWindowThreadProcessId(window, out process);
            if (process != processId) return true;
            var title = new StringBuilder(1024);
            GetWindowText(window, title, title.Capacity);
            if (FindWindowExW(window, IntPtr.Zero, "WRY_WEBVIEW", null) == IntPtr.Zero) return true;
            var state = new TrueDownWindowState {
                handle = window.ToInt64().ToString("x"),
                title = title.ToString(),
                visible = IsWindowVisible(window),
                caption = (GetWindowLong(window, -16) & 0x00c00000) == 0x00c00000,
                resizable = (GetWindowLong(window, -16) & 0x00040000) != 0,
                minimizable = (GetWindowLong(window, -16) & 0x00020000) != 0,
                maximizable = (GetWindowLong(window, -16) & 0x00010000) != 0,
                dpi = (int)GetDpiForWindow(window),
            };
            RECT bounds;
            var origin = new POINT();
            if (!GetWindowRect(window, out bounds) || !ClientToScreen(window, ref origin))
                throw new InvalidOperationException("Cannot read native frame geometry");
            state.clientTopInset = origin.y - bounds.top;
            var caption = new TITLEBARINFOEX { size = (uint)Marshal.SizeOf(typeof(TITLEBARINFOEX)), states = new uint[6], rects = new RECT[6] };
            var memory = Marshal.AllocHGlobal((int)caption.size);
            var region = CreateRectRgn(0, 0, 0, 0);
            try {
                Marshal.StructureToPtr(caption, memory, false);
                IntPtr ignored;
                if (SendMessageTimeoutW(window, 0x033f, UIntPtr.Zero, memory, 2, 1000, out ignored) == IntPtr.Zero)
                    throw new InvalidOperationException("Cannot read native caption accessibility geometry");
                caption = (TITLEBARINFOEX)Marshal.PtrToStructure(memory, typeof(TITLEBARINFOEX));
                var child = FindWindowExW(window, IntPtr.Zero, "WRY_WEBVIEW", null);
                state.captionExcludedFromWebView = child != IntPtr.Zero && GetWindowRgn(child, region) > 0;
                var hits = new List<int>();
                foreach (var index in new int[] { 2, 3, 5 }) {
                    var rectangle = caption.rects[index];
                    var point = new POINT { x = (rectangle.left + rectangle.right) / 2, y = (rectangle.top + rectangle.bottom) / 2 };
                    var position = new IntPtr((point.x & 0xffff) | ((point.y & 0xffff) << 16));
                    IntPtr hit;
                    SendMessageTimeoutW(window, 0x0084, UIntPtr.Zero, position, 2, 1000, out hit);
                    hits.Add(hit.ToInt32());
                    if (rectangle.right <= rectangle.left || rectangle.bottom <= rectangle.top || !ScreenToClient(child, ref point) || PtInRegion(region, point.x, point.y))
                        state.captionExcludedFromWebView = false;
                }
                state.captionHits = hits.ToArray();
            } finally { Marshal.FreeHGlobal(memory); DeleteObject(region); }
            IntPtr icon;
            ICONINFO information;
            if (SendMessageTimeoutW(window, 0x007f, UIntPtr.Zero, IntPtr.Zero, 2, 1000, out icon) != IntPtr.Zero
                && icon != IntPtr.Zero && GetIconInfo(icon, out information)) {
                try {
                    BITMAP bitmap;
                    if (GetObjectW(information.color, Marshal.SizeOf(typeof(BITMAP)), out bitmap) != 0) {
                        state.iconWidth = bitmap.width;
                        state.iconHeight = bitmap.height;
                    }
                } finally {
                    // GetIconInfo owns these copies; the HWND still owns HICON.
                    if (information.color != IntPtr.Zero) DeleteObject(information.color);
                    if (information.mask != IntPtr.Zero) DeleteObject(information.mask);
                }
            }
            state.darkResult = DwmGetWindowAttribute(window, 20, out state.dark, 4);
            state.backdropResult = DwmGetWindowAttribute(window, 38, out state.backdrop, 4);
            state.legacyMicaResult = DwmGetWindowAttribute(window, 1029, out state.legacyMica, 4);
            states.Add(state);
            return true;
        }, IntPtr.Zero);
        } finally {
            if (previousAwareness != IntPtr.Zero) SetThreadDpiAwarenessContext(previousAwareness);
        }
        return states.ToArray();
    }
}
'@

ConvertTo-Json -InputObject @([TrueDownNativeState]::Read([uint32]$ProcessId)) -Compress
