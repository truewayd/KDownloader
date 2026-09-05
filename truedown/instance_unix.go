//go:build linux || darwin

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

type appInstance struct {
	file *os.File
}

func acquireAppInstance(dataDir string) (*appInstance, bool, error) {
	lockPath := filepath.Join(dataDir, "truedown.lock")
	fd, err := unix.Open(lockPath, unix.O_CREAT|unix.O_RDWR|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0o600)
	if err != nil {
		return nil, false, fmt.Errorf("open TrueDown instance lock: %w", err)
	}
	file := os.NewFile(uintptr(fd), lockPath)
	if file == nil {
		_ = unix.Close(fd)
		return nil, false, fmt.Errorf("open TrueDown instance lock handle")
	}
	if info, err := file.Stat(); err != nil || !info.Mode().IsRegular() {
		_ = file.Close()
		return nil, false, fmt.Errorf("TrueDown instance lock must be a regular file")
	}
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		_ = file.Close()
		if errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EAGAIN) {
			return &appInstance{}, true, nil
		}
		return nil, false, fmt.Errorf("lock TrueDown instance: %w", err)
	}
	return &appInstance{file: file}, false, nil
}

func (instance *appInstance) Close() error {
	if instance == nil || instance.file == nil {
		return nil
	}
	fd := int(instance.file.Fd())
	unlockErr := unix.Flock(fd, unix.LOCK_UN)
	closeErr := instance.file.Close()
	instance.file = nil
	return errors.Join(unlockErr, closeErr)
}
