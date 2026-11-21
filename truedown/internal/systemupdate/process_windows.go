//go:build windows

package systemupdate

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func configureHiddenProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000,
	}
}

func configureNativeHelper(command *exec.Cmd) {
	configureHiddenProcess(command)
	// The owned core's kill-on-close job explicitly permits only this helper
	// and user-requested desktop launches to outlive it.
	command.SysProcAttr.CreationFlags |= 0x01000000 // CREATE_BREAKAWAY_FROM_JOB
}

// Keep this manual-reset event alive across the core/helper handoff. A shell
// opened while the install is locked can leave one Open request and exit.
type nativeOpenEvent windows.Handle

func openNativeEvent(token string) (nativeOpenEvent, error) {
	name, err := windows.UTF16PtrFromString("Local\\TrueDown-update-open-" + token)
	if err != nil {
		return 0, err
	}
	attributes := windows.SecurityAttributes{InheritHandle: 1}
	attributes.Length = uint32(unsafe.Sizeof(attributes))
	handle, err := windows.CreateEvent(&attributes, 1, 0, name)
	if err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return 0, err
	}
	return nativeOpenEvent(handle), nil
}

func (event nativeOpenEvent) inherit(command *exec.Cmd) {
	command.SysProcAttr.AdditionalInheritedHandles = []syscall.Handle{syscall.Handle(event)}
}

func (event nativeOpenEvent) requested() bool {
	status, err := windows.WaitForSingleObject(windows.Handle(event), 0)
	return err == nil && status == windows.WAIT_OBJECT_0
}

func (event nativeOpenEvent) close() { _ = windows.CloseHandle(windows.Handle(event)) }

func retryableNativeReplace(err error) bool {
	return errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_ACCESS_DENIED) ||
		errors.Is(err, windows.ERROR_LOCK_VIOLATION) || errors.Is(err, windows.ERROR_USER_MAPPED_FILE)
}

func processCreationTime(process windows.Handle) (uint64, error) {
	var created, exited, kernel, user windows.Filetime
	err := windows.GetProcessTimes(process, &created, &exited, &kernel, &user)
	return uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime), err
}

func captureNativeExitProcesses(shell string) (*nativeExitProcesses, error) {
	coreCreated, err := processCreationTime(windows.CurrentProcess())
	if err != nil {
		return nil, fmt.Errorf("identify outgoing core: %w", err)
	}
	parent := uint32(os.Getppid())
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, parent)
	if err != nil {
		return nil, fmt.Errorf("open outgoing desktop: %w", err)
	}
	defer windows.CloseHandle(process)
	path := make([]uint16, 32768)
	size := uint32(len(path))
	if err := windows.QueryFullProcessImageName(process, 0, &path[0], &size); err != nil {
		return nil, fmt.Errorf("identify outgoing desktop: %w", err)
	}
	if !strings.EqualFold(filepath.Clean(windows.UTF16ToString(path[:size])), filepath.Clean(shell)) {
		return nil, fmt.Errorf("outgoing desktop does not match the installed shell")
	}
	desktopCreated, err := processCreationTime(process)
	if err != nil {
		return nil, fmt.Errorf("read outgoing desktop creation time: %w", err)
	}
	return &nativeExitProcesses{
		Core:    nativeExitProcess{PID: uint32(os.Getpid()), Created: coreCreated},
		Desktop: nativeExitProcess{PID: parent, Created: desktopCreated},
	}, nil
}

func awaitNativeExit(outgoing *nativeExitProcesses, timeout time.Duration) error {
	if outgoing == nil { // Older recovery journals did not carry process identities.
		return nil
	}
	deadline := time.Now().Add(timeout)
	for _, target := range []struct {
		name    string
		process nativeExitProcess
	}{{"core", outgoing.Core}, {"desktop", outgoing.Desktop}} {
		if err := waitForNativeProcess(target.process, deadline); err != nil {
			return fmt.Errorf("wait for outgoing TrueDown %s: %w", target.name, err)
		}
	}
	return nil
}

func waitForNativeProcess(target nativeExitProcess, deadline time.Time) error {
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, target.PID)
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return nil // The process has already exited and its PID is gone.
	}
	if err != nil {
		return err
	}
	defer windows.CloseHandle(process)
	created, err := processCreationTime(process)
	if err != nil || created != target.Created {
		return err // A reused PID belongs to a different process.
	}
	remaining := max(time.Until(deadline), 0)
	status, err := windows.WaitForSingleObject(process, uint32(remaining.Milliseconds()))
	if err != nil {
		return err
	}
	if status != windows.WAIT_OBJECT_0 {
		return fmt.Errorf("process did not exit before the update deadline")
	}
	return nil
}

func nativeUpdateLock(directory string) (func(), bool, error) {
	if resolved, err := filepath.EvalSymlinks(directory); err == nil {
		directory = resolved
	}
	digest := sha256.Sum256([]byte(strings.ToLower(filepath.Clean(directory))))
	name, err := windows.UTF16PtrFromString("Local\\TrueDown-native-update-" + hex.EncodeToString(digest[:16]))
	if err != nil {
		return nil, false, err
	}
	handle, err := windows.CreateMutex(nil, false, name)
	if err != nil && err != windows.ERROR_ALREADY_EXISTS {
		return nil, false, fmt.Errorf("create native update mutex: %w", err)
	}
	var once sync.Once
	release := func() { once.Do(func() { _ = windows.CloseHandle(handle) }) }
	if err == windows.ERROR_ALREADY_EXISTS {
		release()
		return release, true, nil
	}
	return release, false, nil
}
