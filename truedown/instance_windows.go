//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

const errorAlreadyExists syscall.Errno = 183

var createMutexW = syscall.NewLazyDLL("kernel32.dll").NewProc("CreateMutexW")

type appInstance struct {
	handle syscall.Handle
}

func acquireAppInstance(dataDir string) (*appInstance, bool, error) {
	identity := filepath.Clean(dataDir)
	if resolved, err := filepath.EvalSymlinks(identity); err == nil {
		identity = resolved
	}
	identity = strings.ToLower(filepath.Clean(identity))
	digest := sha256.Sum256([]byte(identity))
	name, err := syscall.UTF16PtrFromString("Local\\TrueDown-" + hex.EncodeToString(digest[:16]))
	if err != nil {
		return nil, false, err
	}
	handle, _, callErr := createMutexW.Call(0, 0, uintptr(unsafe.Pointer(name)))
	if handle == 0 {
		return nil, false, fmt.Errorf("create TrueDown instance mutex: %w", callErr)
	}
	instance := &appInstance{handle: syscall.Handle(handle)}
	return instance, callErr == errorAlreadyExists, nil
}

func (instance *appInstance) Close() error {
	if instance == nil || instance.handle == 0 {
		return nil
	}
	err := syscall.CloseHandle(instance.handle)
	instance.handle = 0
	return err
}
