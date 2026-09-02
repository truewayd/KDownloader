//go:build windows

package main

import (
	"runtime"
	"testing"
	"unsafe"
)

func TestWindowsTrayInteropLayouts(t *testing.T) {
	if size := unsafe.Sizeof(trayMessage{}); size != 48 {
		t.Fatalf("MSG layout is %d bytes, want 48", size)
	}
	if size := unsafe.Sizeof(trayWindowClassDefinition{}); size != 80 {
		t.Fatalf("WNDCLASSEX layout is %d bytes, want 80", size)
	}
	if size := unsafe.Sizeof(trayNotifyIconData{}); size != 976 {
		t.Fatalf("NOTIFYICONDATA layout is %d bytes, want 976", size)
	}
}

func TestWindowsTrayUsesPerMonitorV2DPIContext(t *testing.T) {
	if dpiPerMonitorV2 != ^uintptr(3) {
		t.Fatalf("Per-Monitor V2 DPI context=%#x", dpiPerMonitorV2)
	}
	getThreadContext := trayUser32.NewProc("GetThreadDpiAwarenessContext")
	areContextsEqual := trayUser32.NewProc("AreDpiAwarenessContextsEqual")
	if getThreadContext.Find() != nil || areContextsEqual.Find() != nil {
		t.Skip("thread DPI awareness contexts require Windows 10")
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	enableTrayDPIAwareness()
	context, _, _ := getThreadContext.Call()
	equal, _, _ := areContextsEqual.Call(context, dpiPerMonitorV2)
	if equal == 0 {
		t.Fatal("tray thread did not enter the Per-Monitor V2 DPI context")
	}
}
