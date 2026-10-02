//go:build windows

package downloader

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const openPathHelperFlag = "--internal-open-path"
const openWithHelperFlag = "--internal-open-with"

var pathOpenSlots = make(chan struct{}, 4)
var shellExecuteEx = windows.NewLazySystemDLL("shell32.dll").NewProc("ShellExecuteExW")

func systemOpenPath(path string) error {
	return runPathHelper(path, false)
}

func systemOpenWith(path string) error {
	return runPathHelper(path, true)
}

func runPathHelper(path string, choose bool) error {
	select {
	case pathOpenSlots <- struct{}{}:
		defer func() { <-pathOpenSlots }()
	default:
		return fmt.Errorf("another path is still opening; try again shortly")
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	flag, timeout := openPathHelperFlag, 10*time.Second
	if choose {
		flag, timeout = openWithHelperFlag, 5*time.Minute
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	command := exec.CommandContext(ctx, executable, flag)
	command.Stdin = strings.NewReader(path)
	// Shell-launched applications must not inherit the core's kill-on-close job.
	// This small helper skips core/profile startup and avoids Explorer bootstrap.
	configurePathOpenProcess(command)
	command.WaitDelay = 500 * time.Millisecond
	var output pathOpenOutput
	command.Stderr = &output
	if err := command.Run(); err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("system path opener timed out: %w", ctx.Err())
		}
		return fmt.Errorf("system path opener: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func configurePathOpenProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW | windows.CREATE_BREAKAWAY_FROM_JOB}
}

type pathOpenOutput []byte

func (output *pathOpenOutput) Write(value []byte) (int, error) {
	count := len(value)
	if remaining := 4096 - len(*output); remaining > 0 {
		*output = append(*output, value[:min(remaining, count)]...)
	}
	return count, nil
}

// RunPathOpenHelper must run before profile, job and engine initialization.
func RunPathOpenHelper(args []string) (bool, error) {
	if len(args) == 0 || (args[0] != openPathHelperFlag && args[0] != openWithHelperFlag) {
		return false, nil
	}
	if len(args) != 1 {
		return true, fmt.Errorf("invalid path opener arguments")
	}
	parent, err := verifyPathOpenParent()
	if err != nil {
		return true, err
	}
	defer windows.CloseHandle(parent)
	// A private inherited pipe carries one bounded target, never shell arguments.
	deadline := time.AfterFunc(5*time.Second, func() { os.Exit(1) })
	defer deadline.Stop()
	input, err := io.ReadAll(io.LimitReader(os.Stdin, 32769))
	if err != nil || len(input) == 0 || len(input) > 32768 {
		return true, fmt.Errorf("invalid path opener request")
	}
	path := string(input)
	release, err := lockPathOpenTarget(path)
	if err != nil {
		return true, err
	}
	defer release()
	file, err := windows.UTF16FromString(path)
	if err != nil || len(file) > 32767 {
		return true, fmt.Errorf("invalid path opener target")
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED|windows.COINIT_DISABLE_OLE1DDE); err != nil && err != syscall.Errno(1) {
		return true, fmt.Errorf("initialize system path opener: %w", err)
	}
	defer windows.CoUninitialize()
	if args[0] == openWithHelperFlag {
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			return true, fmt.Errorf("open with requires a regular file")
		}
		deadline.Stop()
		infoOpen := struct {
			File  *uint16
			Class *uint16
			Flags uint32
		}{File: &file[0], Flags: 4}
		result, _, _ := windows.NewLazySystemDLL("shell32.dll").NewProc("SHOpenWithDialog").Call(0, uintptr(unsafe.Pointer(&infoOpen)))
		runtime.KeepAlive(file)
		if int32(result) < 0 && uint32(result) != 0x800704c7 {
			return true, fmt.Errorf("Open with failed: 0x%x", uint32(result))
		}
		return true, nil
	}
	verb := windows.StringToUTF16Ptr("open")
	info := shellExecuteInfo{
		// NOASYNC completes shell/DDE dispatch before the helper exits; it does
		// not wait for the opened application to exit. NO_UI reports errors here.
		Mask: 0x00000100 | 0x00000400,
		Verb: verb, File: &file[0], Show: windows.SW_SHOWNORMAL,
	}
	info.Size = uint32(unsafe.Sizeof(info))
	ok, _, callErr := shellExecuteEx.Call(uintptr(unsafe.Pointer(&info)))
	runtime.KeepAlive(file)
	runtime.KeepAlive(verb)
	if ok == 0 {
		return true, fmt.Errorf("ShellExecuteExW: %w", callErr)
	}
	return true, nil
}

func verifyPathOpenParent() (windows.Handle, error) {
	var basic windows.PROCESS_BASIC_INFORMATION
	if err := windows.NtQueryInformationProcess(windows.CurrentProcess(), windows.ProcessBasicInformation, unsafe.Pointer(&basic), uint32(unsafe.Sizeof(basic)), nil); err != nil {
		return 0, err
	}
	pid := uint32(basic.InheritedFromUniqueProcessId)
	var pipePID uint32
	if err := windows.GetNamedPipeServerProcessId(windows.Handle(os.Stdin.Fd()), &pipePID); err != nil || pipePID != pid {
		return 0, fmt.Errorf("path opener requires its core's private input pipe")
	}
	parent, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, pid)
	if err != nil {
		return 0, err
	}
	var name [32768]uint16
	size := uint32(len(name))
	err = windows.QueryFullProcessImageName(parent, 0, &name[0], &size)
	if err != nil || size == 0 || size > uint32(len(name)) {
		windows.CloseHandle(parent)
		return 0, fmt.Errorf("cannot verify path opener parent")
	}
	self, selfErr := os.Executable()
	selfInfo, statErr := os.Stat(self)
	parentInfo, parentErr := os.Stat(windows.UTF16ToString(name[:size]))
	state, waitErr := windows.WaitForSingleObject(parent, 0)
	if err != nil || selfErr != nil || statErr != nil || parentErr != nil || !os.SameFile(selfInfo, parentInfo) || waitErr != nil || state != uint32(windows.WAIT_TIMEOUT) {
		windows.CloseHandle(parent)
		return 0, fmt.Errorf("path opener accepts only its live core process")
	}
	return parent, nil
}

// SHELLEXECUTEINFOW, including its pointer-sized icon/monitor union.
type shellExecuteInfo struct {
	Size       uint32
	Mask       uint32
	Window     windows.Handle
	Verb       *uint16
	File       *uint16
	Parameters *uint16
	Directory  *uint16
	Show       int32
	Instance   windows.Handle
	IDList     uintptr
	Class      *uint16
	ClassKey   windows.Handle
	HotKey     uint32
	Icon       windows.Handle
	Process    windows.Handle
}
