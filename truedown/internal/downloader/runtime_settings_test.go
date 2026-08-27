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
	if settings := manager.RuntimeSettings(); settings.ConcurrentDownloads != 3 || settings.GlobalDownloadLimitBps != 0 {
		t.Fatalf("default runtime settings=%+v", settings)
	}
	if _, err := manager.SetRuntimeSettings(RuntimeSettings{ConcurrentDownloads: 0}); !IsValidationError(err) {
		t.Fatalf("invalid concurrency error=%v", err)
	}
	if _, err := manager.SetRuntimeSettings(RuntimeSettings{
		ConcurrentDownloads:    3,
		GlobalDownloadLimitBps: -1,
	}); !IsValidationError(err) {
		t.Fatalf("invalid global download limit error=%v", err)
	}
	if _, err := manager.SetRuntimeSettings(RuntimeSettings{
		ConcurrentDownloads:    3,
		GlobalDownloadLimitBps: maxGlobalDownloadLimitBps + 1,
	}); !IsValidationError(err) {
		t.Fatalf("oversized global download limit error=%v", err)
	}
	fake := &fakeAriaRPC{}
	manager.rpc = fake
	saved, err := manager.SetRuntimeSettings(RuntimeSettings{
		ConcurrentDownloads:    7,
		GlobalDownloadLimitBps: 8 * 1024 * 1024,
	})
	if err != nil || saved.ConcurrentDownloads != 7 || saved.GlobalDownloadLimitBps != 8*1024*1024 {
		t.Fatalf("saved runtime settings=%+v err=%v", saved, err)
	}
	if len(fake.globalOptions) != 1 || fake.globalOptions[0]["max-concurrent-downloads"] != "7" ||
		fake.globalOptions[0]["max-overall-download-limit"] != "8388608" {
		t.Fatalf("aria2 global options=%v", fake.globalOptions)
	}
	legacy, err := manager.UpdateRuntimeSettings(RuntimeSettingsUpdate{ConcurrentDownloads: 5})
	if err != nil || legacy.ConcurrentDownloads != 5 || legacy.GlobalDownloadLimitBps != 8*1024*1024 {
		t.Fatalf("legacy runtime update=%+v err=%v", legacy, err)
	}
	manager.Stop()

	reloaded, err := NewManager("unused", filepath.Join(root, "downloads"), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer reloaded.Stop()
	if settings := reloaded.RuntimeSettings(); settings.ConcurrentDownloads != 5 || settings.GlobalDownloadLimitBps != 8*1024*1024 {
		t.Fatalf("reloaded runtime settings=%+v", settings)
	}
}
