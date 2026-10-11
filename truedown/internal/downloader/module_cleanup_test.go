package downloader

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestModuleRetentionOnlyPrunesBeforeProcessesStart(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	m, err := NewManager("unused", filepath.Join(base, "downloads"), filepath.Join(base, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	root := m.executableRoot("mega")
	entry := "provider"
	if runtime.GOOS == "windows" {
		entry += ".exe"
	}
	old := time.Now().Add(-48 * time.Hour)
	for _, version := range []string{"0.2.0", "0.3.0", "0.4.0", "0.5.0", ".install-123", "foreign"} {
		directory := filepath.Join(root, version)
		if err := os.MkdirAll(directory, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, entry), []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(directory, old, old); err != nil {
			t.Fatal(err)
		}
	}
	// Invalid/missing active metadata fails closed for installed versions.
	m.cleanupModuleCache(true)
	if _, err := os.Stat(filepath.Join(root, "0.2.0", entry)); err != nil {
		t.Fatal("invalid active pointer authorized cleanup", err)
	}
	// A verified activation while tasks run must not unlink captured executables.
	m.cleanupModuleCacheForVersion(false, "0.4.0")
	if _, err := os.Stat(filepath.Join(root, "0.2.0", entry)); err != nil {
		t.Fatal("live executable removed", err)
	}
	m.cleanupModuleCacheForVersion(true, "0.4.0")
	if _, err := os.Stat(filepath.Join(root, "0.2.0")); !os.IsNotExist(err) {
		t.Fatal("old version retained", err)
	}
	for _, name := range []string{"0.3.0", "0.4.0", "0.5.0", "foreign"} {
		if _, err := os.Stat(filepath.Join(root, name, entry)); err != nil {
			t.Fatal("protected version removed", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(root, ".install-123")); !os.IsNotExist(err) {
		t.Fatal("abandoned stage retained", err)
	}
	// Explicit previous selection takes priority over a newer failed candidate.
	if err := os.WriteFile(filepath.Join(root, "previous.json"), []byte(`{"version":"0.3.0"}`), 0600); err != nil {
		t.Fatal(err)
	}
	m.cleanupModuleCacheForVersion(true, "0.5.0")
	if _, err := os.Stat(filepath.Join(root, "0.3.0", entry)); err != nil {
		t.Fatal("previous selection removed", err)
	}
	if _, err := os.Stat(filepath.Join(root, "0.4.0")); !os.IsNotExist(err) {
		t.Fatal("superseded nonprevious version retained", err)
	}
}
