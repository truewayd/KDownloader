//go:build windows

package main

import (
	"runtime"
	"runtime/debug"
	"syscall"
	"testing"
	"unsafe"
)

func TestWindowsTrayMenuLabelsSurviveGC(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	previousGC := debug.SetGCPercent(1)
	defer debug.SetGCPercent(previousGC)
	getMenuString := trayUser32.NewProc("GetMenuStringW")
	want := []string{"\u6253\u5f00 TrueDown", "\u6253\u5f00\u4e0b\u8f7d\u76ee\u5f55", "\u6253\u5f00\u5e94\u7528\u65e5\u5fd7", "", "\u9000\u51fa"}
	for range 16 {
		state := &trayState{}
		if err := state.createMenu(); err != nil {
			t.Fatal(err)
		}
		runtime.GC()
		for index, expected := range want {
			var label [128]uint16
			getMenuString.Call(state.menu, uintptr(index), uintptr(unsafe.Pointer(&label[0])), uintptr(len(label)), 0x0400)
			if actual := syscall.UTF16ToString(label[:]); actual != expected {
				destroyMenu.Call(state.menu)
				t.Fatalf("menu label %d=%q, want %q", index, actual, expected)
			}
		}
		destroyMenu.Call(state.menu)
	}
}

func TestWindowsTrayInteropLayouts(t *testing.T) {
	if trayNotifyID != 1 || trayIconResourceID != 2 {
		t.Fatalf("tray IDs notify=%d resource=%d", trayNotifyID, trayIconResourceID)
	}
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
