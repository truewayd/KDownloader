//go:build linux || darwin

package profile

import (
	"context"
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
		got, err := DefaultDirectory()
		if err != nil || got != filepath.Join(dataHome, "truedown") {
			t.Fatalf("Linux data directory=%q err=%v", got, err)
		}
		return
	}
	_ = os.Unsetenv("XDG_DATA_HOME")
	got, err := DefaultDirectory()
	if err != nil || got != filepath.Join(home, "Library", "Application Support", "TrueDown") {
		t.Fatalf("macOS data directory=%q err=%v", got, err)
	}
}

func TestUnixRolesUsePlatformDirectoriesAndRemainPinned(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("TRUEDOWN_DATA_DIR", "")
	for _, key := range []string{"XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"} {
		t.Setenv(key, filepath.Join(home, key))
	}
	location, err := Resolve("", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "linux" {
		if location.Paths.Config != filepath.Join(home, "XDG_CONFIG_HOME", "truedown") || location.Paths.State != filepath.Join(home, "XDG_STATE_HOME", "truedown") || location.Paths.Cache != filepath.Join(home, "XDG_CACHE_HOME", "truedown") {
			t.Fatal(location.Paths)
		}
	} else if location.Paths.Logs != filepath.Join(home, "Library", "Logs", "TrueDown") || location.Paths.Cache != filepath.Join(home, "Library", "Caches", "TrueDown") {
		t.Fatal(location.Paths)
	}
	os.MkdirAll(location.DataDirectory, 0700)
	location, err = Initialize(context.Background(), location, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "changed-config"))
	again, err := Resolve(location.DataDirectory, "")
	if err != nil || again.Paths != location.Paths {
		t.Fatal(again, err)
	}
}
