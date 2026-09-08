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
            if (title.Length == 0 && (GetWindowLong(window, -16) & 0x00c00000) != 0x00c00000) return true;
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
