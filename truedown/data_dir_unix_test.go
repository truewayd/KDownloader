//go:build linux || darwin

package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestUnixDefaultDataDirectory(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if runtime.GOOS == "linux" {
		dataHome := filepath.Join(home, "xdg-data")
		t.Setenv("XDG_DATA_HOME", dataHome)
		got, err := defaultDataDir("unused")
		if err != nil || got != filepath.Join(dataHome, "truedown") {
			t.Fatalf("Linux data directory=%q err=%v", got, err)
		}
		return
	}
	_ = os.Unsetenv("XDG_DATA_HOME")
	got, err := defaultDataDir("unused")
	if err != nil || got != filepath.Join(home, "Library", "Application Support", "TrueDown") {
		t.Fatalf("macOS data directory=%q err=%v", got, err)
	}
}
