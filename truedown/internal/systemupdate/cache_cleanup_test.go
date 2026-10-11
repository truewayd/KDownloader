package systemupdate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCacheRetentionProtectsTransactionsAndEngineSelections(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	m := newTestManager(t, base, filepath.Join(base, "aria2.exe"), Options{})
	old := time.Now().Add(-48 * time.Hour)
	write := func(path string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("cache"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, old, old); err != nil {
			t.Fatal(err)
		}
	}
	for _, version := range []string{"1.0.0", "2.0.0", "3.0.0", "4.0.0"} {
		write(filepath.Join(m.enginesDir, "aria2-next-"+version+"-windows-x86_64.exe"))
	}
	m.active.File = "aria2-next-2.0.0-windows-x86_64.exe"
	m.state.PreviousNextEngine = &installedEngine{File: "aria2-next-3.0.0-windows-x86_64.exe"}
	m.state.NextEngine = &installedEngine{File: "aria2-next-4.0.0-windows-x86_64.exe"}
	for _, name := range []string{"native-build-1-123", "native-build-2-123", "native-build-3-123"} {
		write(filepath.Join(m.updatesDir, name, "TrueDown.exe"))
		if err := os.Chtimes(filepath.Join(m.updatesDir, name), old, old); err != nil {
			t.Fatal(err)
		}
	}
	m.state.PendingUpdate = &pendingAppUpdate{File: "native-build-2-123"}
	write(filepath.Join(m.updatesDir, "native-build-3-123", "user.txt"))
	if err := os.Chtimes(filepath.Join(m.updatesDir, "native-build-3-123"), old, old); err != nil {
		t.Fatal(err)
	}
	write(filepath.Join(m.updatesDir, ".download-123.tmp"))
	write(filepath.Join(m.updatesDir, "user-download.zip"))
	helper := filepath.Join(m.updatesDir, "TrueDown-native-updater-"+strings.Repeat("a", 48)+".exe")
	write(helper)
	marker := filepath.Join(m.baseDir, nativeMarkerName)
	write(marker)
	m.cleanupUpdateCache()
	if _, err := os.Stat(helper); err != nil {
		t.Fatal("transaction helper removed", err)
	}
	if _, err := os.Stat(filepath.Join(m.updatesDir, "native-build-1-123")); err != nil {
		t.Fatal("transaction stage removed", err)
	}
	if err := os.Remove(marker); err != nil {
		t.Fatal(err)
	}
	m.busy = "truedown"
	m.cleanupUpdateCache()
	if _, err := os.Stat(filepath.Join(m.updatesDir, ".download-123.tmp")); err != nil {
		t.Fatal("busy copy removed", err)
	}
	m.busy = ""
	m.cleanupUpdateCache()
	for _, path := range []string{filepath.Join(m.updatesDir, "native-build-1-123"), filepath.Join(m.updatesDir, ".download-123.tmp"), filepath.Join(m.enginesDir, "aria2-next-1.0.0-windows-x86_64.exe")} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatal("obsolete cache retained", path, err)
		}
	}
	if _, err := os.Stat(helper); !os.IsNotExist(err) {
		t.Fatal("orphan helper retained", err)
	}
	for _, path := range []string{filepath.Join(m.updatesDir, "native-build-2-123", "TrueDown.exe"), filepath.Join(m.updatesDir, "native-build-3-123", "TrueDown.exe"), filepath.Join(m.updatesDir, "user-download.zip"), filepath.Join(m.enginesDir, m.active.File), filepath.Join(m.enginesDir, m.state.NextEngine.File), filepath.Join(m.enginesDir, m.state.PreviousNextEngine.File)} {
		if _, err := os.Stat(path); err != nil {
			t.Fatal("retained file removed", path, err)
		}
	}
}
