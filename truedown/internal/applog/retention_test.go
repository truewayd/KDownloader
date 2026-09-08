package applog

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDailyRotationExpiresOldArchivesAndKeepsRecentDiagnostics(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, fileName)
	yesterday := time.Now().Add(-24 * time.Hour)
	for _, name := range []string{path, path + ".1", path + ".2"} {
		if err := os.WriteFile(name, []byte("previous diagnostics\n"), 0600); err != nil {
			t.Fatal(err)
		}
		date := yesterday
		if name != path {
			date = time.Now().Add(-8 * 24 * time.Hour)
		}
		if err := os.Chtimes(name, date, date); err != nil {
			t.Fatal(err)
		}
	}
	logger, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer logger.Close()
	if logger.size != 0 {
		t.Fatal("yesterday's log did not rotate")
	}
	if _, err := os.Stat(path + ".1"); err != nil {
		t.Fatal("recent diagnostics lost", err)
	}
	for _, suffix := range []string{".2", ".3"} {
		if _, err := os.Stat(path + suffix); !os.IsNotExist(err) {
			t.Fatal("expired archive retained", suffix, err)
		}
	}
	if _, err := logger.Write([]byte("current diagnostics\n")); err != nil {
		t.Fatal(err)
	}
	logger.mu.Lock()
	err = logger.maintain(time.Now().Add(8 * 24 * time.Hour))
	logger.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path + ".1"); !os.IsNotExist(err) {
		t.Fatal("idle maintenance retained expired data", err)
	}
}
