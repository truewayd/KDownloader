//go:build windows

package main

import (
	"fmt"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	trayWindowClass = "TrueDownTrayWindow"
	trayNotifyID    = 1
	// rsrc assigns the manifest resource ID 1 and the icon group ID 2 when
	// both are linked. Keep this distinct from the Shell_NotifyIcon identity.
	trayIconResourceID = 2

	wmClose           = 0x0010
	wmCommand         = 0x0111
	wmDestroy         = 0x0002
	wmQueryEndSession = 0x0011
	wmEndSession      = 0x0016
	wmNull            = 0x0000
	wmContextMenu     = 0x007B
	wmUser            = 0x0400
	wmApp             = 0x8000
	wmLButtonDblClk   = 0x0203
	wmRButtonUp       = 0x0205
	ninSelect         = wmUser
	ninKeySelect      = wmUser + 1
	trayCallback      = wmApp + 1
	imageIcon         = 1
	lrDefaultSize     = 0x0040
	nifMessage        = 0x0001
	nifIcon           = 0x0002
	nifTip            = 0x0004
	nifShowTip        = 0x0080
	nimAdd            = 0x0000
	nimDelete         = 0x0002
	nimSetVersion     = 0x0004
	notifyVersion4    = 4
	mfString          = 0x0000
	mfSeparator       = 0x0800
	tpmRightButton    = 0x0002
	tpmReturnCommand  = 0x0100
	swShownormal      = 1
	dpiPerMonitorV2   = ^uintptr(3)

	menuOpenDashboard = 1001
	menuOpenDownloads = 1002
	menuOpenLog       = 1003
	menuExit          = 1004
)

var (
	trayUser32            = syscall.NewLazyDLL("user32.dll")
	trayShell32           = syscall.NewLazyDLL("shell32.dll")
	trayKernel32          = syscall.NewLazyDLL("kernel32.dll")
	registerClassExW      = trayUser32.NewProc("RegisterClassExW")
	createWindowExW       = trayUser32.NewProc("CreateWindowExW")
	defWindowProcW        = trayUser32.NewProc("DefWindowProcW")
	destroyWindow         = trayUser32.NewProc("DestroyWindow")
	postQuitMessage       = trayUser32.NewProc("PostQuitMessage")
	postMessageW          = trayUser32.NewProc("PostMessageW")
	getMessageW           = trayUser32.NewProc("GetMessageW")
	translateMessage      = trayUser32.NewProc("TranslateMessage")
	dispatchMessageW      = trayUser32.NewProc("DispatchMessageW")
	loadImageW            = trayUser32.NewProc("LoadImageW")
	destroyIcon           = trayUser32.NewProc("DestroyIcon")
	createPopupMenu       = trayUser32.NewProc("CreatePopupMenu")
	destroyMenu           = trayUser32.NewProc("DestroyMenu")
	appendMenuW           = trayUser32.NewProc("AppendMenuW")
	trackPopupMenu        = trayUser32.NewProc("TrackPopupMenu")
	getCursorPos          = trayUser32.NewProc("GetCursorPos")
	setForegroundWindow   = trayUser32.NewProc("SetForegroundWindow")
	setThreadDPIContext   = trayUser32.NewProc("SetThreadDpiAwarenessContext")
	registerWindowMessage = trayUser32.NewProc("RegisterWindowMessageW")
	shellNotifyIconW      = trayShell32.NewProc("Shell_NotifyIconW")
	shellExecuteW         = trayShell32.NewProc("ShellExecuteW")
	getModuleHandleW      = trayKernel32.NewProc("GetModuleHandleW")
	trayWindowCallback    = syscall.NewCallback(trayWindowProc)
	trayWindows           sync.Map
)

type trayPoint struct {
	X int32
	Y int32
}

type trayMessage struct {
	Window  uintptr
	Message uint32
	padding uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Point   trayPoint
	Private uint32
}

type trayWindowClassDefinition struct {
	Size        uint32
	Style       uint32
	WindowProc  uintptr
	ClassExtra  int32
	WindowExtra int32
	Instance    uintptr
	Icon        uintptr
	Cursor      uintptr
	Background  uintptr
	MenuName    *uint16
	ClassName   *uint16
	SmallIcon   uintptr
}

type trayNotifyIconData struct {
	Size            uint32
	Window          uintptr
	ID              uint32
	Flags           uint32
	CallbackMessage uint32
	Icon            uintptr
	Tip             [128]uint16
	State           uint32
	StateMask       uint32
	Info            [256]uint16
	Version         uint32
	InfoTitle       [64]uint16
	InfoFlags       uint32
	GUID            [16]byte
	BalloonIcon     uintptr
}

type trayState struct {
	window                uintptr
	menu                  uintptr
	icon                  uintptr
	notify                trayNotifyIconData
	actions               chan platformAction
	taskbarCreatedMessage uint32
}

type trayStartResult struct {
	state *trayState
	err   error
}

func startPlatformApp() (*platformApp, error) {
	started := make(chan trayStartResult, 1)
	actions := make(chan platformAction, 8)
	done := make(chan struct{})
	go runTray(actions, started, done)
	result := <-started
	if result.err != nil {
		return nil, result.err
	}
	return &platformApp{
		actions:     actions,
		description: "system tray",
		closeFn: func() {
			postMessageW.Call(result.state.window, wmClose, 0, 0)
			select {
			case <-done:
			case <-time.After(2 * time.Second):
			}
		},
	}, nil
}

func runTray(actions chan platformAction, started chan<- trayStartResult, done chan<- struct{}) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(done)
	enableTrayDPIAwareness()
	state, err := createTray(actions)
	if err != nil {
		started <- trayStartResult{err: err}
		close(actions)
		return
	}
	started <- trayStartResult{state: state}
	defer state.release()
	defer close(actions)

	var message trayMessage
	for {
		result, _, callErr := getMessageW.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(result) == -1 {
			_ = callErr
			return
		}
		if result == 0 {
			return
		}
		translateMessage.Call(uintptr(unsafe.Pointer(&message)))
		dispatchMessageW.Call(uintptr(unsafe.Pointer(&message)))
	}
}

func enableTrayDPIAwareness() {
	// The embedded manifest establishes the process default. Setting the tray
	// thread as well keeps popup coordinates and system menu metrics physical
	// when the taskbar lives on a monitor with a different scale factor.
	if err := setThreadDPIContext.Find(); err != nil {
		return
	}
	setThreadDPIContext.Call(dpiPerMonitorV2)
}

func createTray(actions chan platformAction) (*trayState, error) {
	instance, _, instanceErr := getModuleHandleW.Call(0)
	if instance == 0 {
		return nil, fmt.Errorf("resolve TrueDown module for tray: %w", instanceErr)
	}
	icon, _, iconErr := loadImageW.Call(instance, trayIconResourceID, imageIcon, 0, 0, lrDefaultSize)
	if icon == 0 {
		return nil, fmt.Errorf("load TrueDown tray icon: %w", iconErr)
	}
	className, _ := syscall.UTF16PtrFromString(trayWindowClass)
	class := trayWindowClassDefinition{
		Size:       uint32(unsafe.Sizeof(trayWindowClassDefinition{})),
		WindowProc: trayWindowCallback,
		Instance:   instance,
		Icon:       icon,
		ClassName:  className,
		SmallIcon:  icon,
	}
	atom, _, classErr := registerClassExW.Call(uintptr(unsafe.Pointer(&class)))
	if atom == 0 && classErr != errorAlreadyExists {
		destroyIcon.Call(icon)
		return nil, fmt.Errorf("register TrueDown tray window: %w", classErr)
	}
	windowName, _ := syscall.UTF16PtrFromString("TrueDown")
	window, _, windowErr := createWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(windowName)),
		0,
		0, 0, 0, 0,
		0, 0, instance, 0,
	)
	if window == 0 {
		destroyIcon.Call(icon)
		return nil, fmt.Errorf("create TrueDown tray window: %w", windowErr)
	}
	state := &trayState{window: window, icon: icon, actions: actions}
	trayWindows.Store(window, state)
	if err := state.createMenu(); err != nil {
		state.release()
		destroyWindow.Call(window)
		return nil, err
	}
	taskbarMessageName, _ := syscall.UTF16PtrFromString("TaskbarCreated")
	taskbarMessage, _, _ := registerWindowMessage.Call(uintptr(unsafe.Pointer(taskbarMessageName)))
	state.taskbarCreatedMessage = uint32(taskbarMessage)
	state.notify = trayNotifyIconData{
		Size:            uint32(unsafe.Sizeof(trayNotifyIconData{})),
		Window:          window,
		ID:              trayNotifyID,
		Flags:           nifMessage | nifIcon | nifTip | nifShowTip,
		CallbackMessage: trayCallback,
		Icon:            icon,
	}
	tip, _ := syscall.UTF16FromString("TrueDown")
	copy(state.notify.Tip[:], tip)
	if err := state.addIcon(); err != nil {
		state.release()
		destroyWindow.Call(window)
		return nil, err
	}
	return state, nil
}

func (state *trayState) createMenu() error {
	menu, _, menuErr := createPopupMenu.Call()
	if menu == 0 {
		return fmt.Errorf("create TrueDown tray menu: %w", menuErr)
	}
	state.menu = menu
	items := []struct {
		flags uintptr
		id    uintptr
		label string
	}{
		{mfString, menuOpenDashboard, "打开 TrueDown"},
		{mfString, menuOpenDownloads, "打开下载目录"},
		{mfString, menuOpenLog, "打开应用日志"},
		{mfSeparator, 0, ""},
		{mfString, menuExit, "退出"},
	}
	for _, item := range items {
		var labelPointer uintptr
		if item.label != "" {
			label, _ := syscall.UTF16PtrFromString(item.label)
			labelPointer = uintptr(unsafe.Pointer(label))
		}
		ok, _, appendErr := appendMenuW.Call(menu, item.flags, item.id, labelPointer)
		if ok == 0 {
			return fmt.Errorf("create TrueDown tray menu item: %w", appendErr)
		}
	}
	return nil
}

func (state *trayState) addIcon() error {
	state.notify.Version = 0
	ok, _, addErr := shellNotifyIconW.Call(nimAdd, uintptr(unsafe.Pointer(&state.notify)))
	if ok == 0 {
		return fmt.Errorf("add TrueDown tray icon: %w", addErr)
	}
	state.notify.Version = notifyVersion4
	ok, _, versionErr := shellNotifyIconW.Call(nimSetVersion, uintptr(unsafe.Pointer(&state.notify)))
	if ok == 0 {
		shellNotifyIconW.Call(nimDelete, uintptr(unsafe.Pointer(&state.notify)))
		return fmt.Errorf("set TrueDown tray icon version: %w", versionErr)
	}
	return nil
}

func (state *trayState) showMenu() {
	var point trayPoint
	if ok, _, _ := getCursorPos.Call(uintptr(unsafe.Pointer(&point))); ok == 0 {
		return
	}
	setForegroundWindow.Call(state.window)
	command, _, _ := trackPopupMenu.Call(
		state.menu,
		tpmRightButton|tpmReturnCommand,
		uintptr(point.X), uintptr(point.Y),
		0,
		state.window,
		0,
	)
	postMessageW.Call(state.window, wmNull, 0, 0)
	state.handleMenuCommand(command)
}

func (state *trayState) handleMenuCommand(command uintptr) {
	switch command & 0xffff {
	case menuOpenDashboard:
		state.send(platformOpenDashboard)
	case menuOpenDownloads:
		state.send(platformOpenDownloads)
	case menuOpenLog:
		state.send(platformOpenLog)
	case menuExit:
		state.send(platformExit)
	}
}

func (state *trayState) send(action platformAction) {
	select {
	case state.actions <- action:
	default:
	}
}

func (state *trayState) release() {
	trayWindows.Delete(state.window)
	state.removeIcon()
	if state.menu != 0 {
		destroyMenu.Call(state.menu)
		state.menu = 0
	}
	if state.icon != 0 {
		destroyIcon.Call(state.icon)
		state.icon = 0
	}
}

func (state *trayState) removeIcon() {
	if state.notify.Window == 0 {
		return
	}
	shellNotifyIconW.Call(nimDelete, uintptr(unsafe.Pointer(&state.notify)))
	state.notify.Window = 0
}

func trayWindowProc(window uintptr, message uint32, wParam, lParam uintptr) uintptr {
	value, found := trayWindows.Load(window)
	if found {
		state := value.(*trayState)
		if message == state.taskbarCreatedMessage && message != 0 {
			_ = state.addIcon()
			return 0
		}
		if message == trayCallback {
			event := uint32(lParam & 0xffff)
			switch event {
			case ninSelect, ninKeySelect, wmLButtonDblClk:
				state.send(platformOpenDashboard)
			case wmContextMenu, wmRButtonUp:
				state.showMenu()
			}
			return 0
		}
		if message == wmCommand {
			state.handleMenuCommand(wParam)
			return 0
		}
		if message == wmClose {
			state.removeIcon()
			destroyWindow.Call(window)
			return 0
		}
		if message == wmQueryEndSession {
			return 1
		}
		if message == wmEndSession {
			if wParam != 0 {
				state.send(platformExit)
			}
			return 0
		}
		if message == wmDestroy {
			postQuitMessage.Call(0)
			return 0
		}
	}
	result, _, _ := defWindowProcW.Call(window, uintptr(message), wParam, lParam)
	return result
}

func openPlatformPath(path string) error {
	verb, _ := syscall.UTF16PtrFromString("open")
	target, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	result, _, callErr := shellExecuteW.Call(
		0,
		uintptr(unsafe.Pointer(verb)),
		uintptr(unsafe.Pointer(target)),
		0,
		0,
		swShownormal,
	)
	if result <= 32 {
		return fmt.Errorf("open %s: ShellExecute code %d (%v)", path, result, callErr)
	}
	return nil
}
