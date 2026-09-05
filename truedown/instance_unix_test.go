//go:build linux || darwin

package main

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestUnixInstanceLockRejectsNonRegularFiles(t *testing.T) {
	for _, kind := range []string{"fifo", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			directory := t.TempDir()
			path := filepath.Join(directory, "truedown.lock")
			var err error
			if kind == "fifo" {
				err = unix.Mkfifo(path, 0600)
			} else {
				target := filepath.Join(t.TempDir(), "target")
				if err = os.WriteFile(target, nil, 0600); err == nil {
					err = os.Symlink(target, path)
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			instance, running, err := acquireAppInstance(directory)
			if instance != nil {
				_ = instance.Close()
			}
			if err == nil || running {
				t.Fatalf("nonregular lock accepted: running=%v err=%v", running, err)
			}
		})
	}
}

func TestUnixInstanceLockIsScopedToDataDirectory(t *testing.T) {
	firstDir := t.TempDir()
	first, alreadyRunning, err := acquireAppInstance(firstDir)
	if err != nil || alreadyRunning {
		t.Fatalf("first instance existing=%v err=%v", alreadyRunning, err)
	}
	defer first.Close()
	second, alreadyRunning, err := acquireAppInstance(firstDir)
	if err != nil || !alreadyRunning {
		t.Fatalf("second instance existing=%v err=%v", alreadyRunning, err)
	}
	_ = second.Close()
	other, alreadyRunning, err := acquireAppInstance(t.TempDir())
	if err != nil || alreadyRunning {
		t.Fatalf("other data directory existing=%v err=%v", alreadyRunning, err)
	}
	_ = other.Close()
}
