//go:build windows

// Package enginesignal requests a normal engine stop without the RPC delay.
package enginesignal

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const helperFlag = "--internal-engine-interrupt"

var (
	kernel32              = windows.NewLazySystemDLL("kernel32.dll")
	attachConsole         = kernel32.NewProc("AttachConsole")
	freeConsole           = kernel32.NewProc("FreeConsole")
	getConsoleProcessList = kernel32.NewProc("GetConsoleProcessList")
	setConsoleCtrlHandler = kernel32.NewProc("SetConsoleCtrlHandler")
)

// Interrupt uses a short-lived helper: attaching a console resets the caller's
// signal handlers, so the service itself must never attach to the engine.
func Interrupt(process *os.Process) error {
	if process == nil {
		return fmt.Errorf("engine process unavailable")
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, helperFlag, strconv.Itoa(process.Pid))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("engine interrupt helper: %w: %s", err, output)
	}
	return nil
}

// RunHelper must run before service initialization. It never opens a profile.
func RunHelper(args []string) (bool, error) {
	if len(args) == 0 || args[0] != helperFlag {
		return false, nil
	}
	if len(args) != 2 {
		return true, fmt.Errorf("invalid engine interrupt arguments")
	}
	pid, err := strconv.ParseUint(args[1], 10, 32)
	if err != nil || pid == 0 || pid == uint64(os.Getpid()) {
		return true, fmt.Errorf("invalid engine process")
	}
	// Keep the process identity alive through signal delivery.
	process, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return true, err
	}
	defer windows.CloseHandle(process)
	if status, err := windows.WaitForSingleObject(process, 0); err != nil || status != uint32(windows.WAIT_TIMEOUT) {
		return true, fmt.Errorf("engine has already exited")
	}
	freeConsole.Call()
	if ok, _, err := attachConsole.Call(uintptr(pid)); ok == 0 {
		return true, fmt.Errorf("attach engine console: %w", err)
	}
	// Console control events broadcast to a console. Refuse any shared console so it
	// cannot interrupt a terminal, the service, or unrelated applications.
	var ids [3]uint32
	count, _, err := getConsoleProcessList.Call(uintptr(unsafe.Pointer(&ids[0])), uintptr(len(ids)))
	if count != 2 || !((ids[0] == uint32(pid) && ids[1] == uint32(os.Getpid())) || (ids[1] == uint32(pid) && ids[0] == uint32(os.Getpid()))) {
		return true, fmt.Errorf("engine console is not private (count=%d): %v", count, err)
	}
	// BREAK is not suppressed by an inherited CTRL+C-ignore flag. Both aria2
	// engines map it to their normal SIGINT checkpoint/cleanup handler.
	// Keep our handler installed until process exit: delivery is asynchronous.
	ignore := windows.NewCallback(func(uint32) uintptr { return 1 })
	if ok, _, err := setConsoleCtrlHandler.Call(ignore, 1); ok == 0 {
		return true, fmt.Errorf("ignore helper interrupt: %w", err)
	}
	return true, windows.GenerateConsoleCtrlEvent(windows.CTRL_BREAK_EVENT, 0)
}
