package downloader

import (
	"path/filepath"
	"testing"
)

func TestRuntimeSettingsDefaultValidateAndPersist(t *testing.T) {
	root := t.TempDir()
	databasePath := filepath.Join(root, "records.db")
	manager, err := NewManager("unused", filepath.Join(root, "downloads"), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if settings := manager.RuntimeSettings(); settings.ConcurrentDownloads != 3 {
		t.Fatalf("default runtime settings=%+v", settings)
	}
	if _, err := manager.SetRuntimeSettings(RuntimeSettings{ConcurrentDownloads: 0}); !IsValidationError(err) {
		t.Fatalf("invalid concurrency error=%v", err)
	}
	fake := &fakeAriaRPC{}
	manager.rpc = fake
	saved, err := manager.SetRuntimeSettings(RuntimeSettings{ConcurrentDownloads: 7})
	if err != nil || saved.ConcurrentDownloads != 7 {
		t.Fatalf("saved runtime settings=%+v err=%v", saved, err)
	}
	if len(fake.globalOptions) != 1 || fake.globalOptions[0]["max-concurrent-downloads"] != "7" {
		t.Fatalf("aria2 global options=%v", fake.globalOptions)
	}
	manager.Stop()

	reloaded, err := NewManager("unused", filepath.Join(root, "downloads"), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer reloaded.Stop()
	if settings := reloaded.RuntimeSettings(); settings.ConcurrentDownloads != 7 {
		t.Fatalf("reloaded runtime settings=%+v", settings)
	}
}
