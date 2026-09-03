//go:build linux || darwin

package main

import "testing"

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
