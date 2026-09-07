//go:build windows

package systemupdate

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"golang.org/x/sys/windows"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
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
