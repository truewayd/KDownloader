package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"truedown/internal/downloader"
	"truedown/internal/systemupdate"
)

func TestManagerHostReloadsStableEngineInProcess(t *testing.T) {
	if os.Getenv("TRUEDOWN_INTEGRATION") != "1" {
		t.Skip("set TRUEDOWN_INTEGRATION=1 to run the aria2 integration test")
	}
	aria2Path, err := filepath.Abs(filepath.Join("aria2", "aria2c.exe"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(aria2Path); err != nil {
		t.Skipf("aria2 executable unavailable: %v", err)
	}
	root := t.TempDir()
	payload := bytes.Repeat([]byte("TrueDown warm engine switch\n"), 32*1024)
	sourceDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(sourceDir, "payload.bin"), payload, 0600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.FileServer(http.Dir(sourceDir)))
	defer server.Close()
	spec := systemupdate.EngineSpec{Kind: systemupdate.EngineStable, Version: "1.37.0", Path: aria2Path, File: filepath.Base(aria2Path)}
	build := func(spec systemupdate.EngineSpec) (*downloader.Manager, error) {
		return downloader.NewManager(spec.Path, filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	}
	manager, err := build(spec)
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.Start(); err != nil {
		manager.Stop()
		t.Fatal(err)
	}
	host := &managerHost{}
	host.configure(manager, spec, build, func(*downloader.Manager) http.Handler { return http.NewServeMux() })
	defer host.stop()
	task, duplicate, err := manager.AddTask(server.URL+"/payload.bin", "payload.bin", "", nil, "", 0, downloader.Aria2Opts{MaxSpeedBps: 32 * 1024})
	if err != nil || duplicate {
		t.Fatalf("add integration task: task=%+v duplicate=%v err=%v", task, duplicate, err)
	}
	waitForManagerStatus(t, manager, task.ID, downloader.StatusDownloading, 10*time.Second)
	paused, duplicate, err := manager.AddTask(server.URL+"/payload.bin", "paused.bin", "", nil, "", 0, downloader.Aria2Opts{MaxSpeedBps: 32 * 1024})
	if err != nil || duplicate {
		t.Fatalf("add paused integration task: task=%+v duplicate=%v err=%v", paused, duplicate, err)
	}
	waitForManagerStatus(t, manager, paused.ID, downloader.StatusDownloading, 10*time.Second)
	if err := manager.PauseTask(paused.ID); err != nil {
		t.Fatal(err)
	}
	waitForManagerStatus(t, manager, paused.ID, downloader.StatusPaused, 5*time.Second)

	result, err := host.transition(nil, spec, nil, 1)
	if err != nil || !result.TargetLive || !sameRuntimeEngine(result.Active, spec) {
		t.Fatalf("stable engine reload result=%+v err=%v", result, err)
	}
	host.mu.RLock()
	reloaded := host.current.manager
	host.mu.RUnlock()
	waitForManagerStatus(t, reloaded, paused.ID, downloader.StatusPaused, 10*time.Second)
	waitForManagerStatus(t, reloaded, task.ID, downloader.StatusDone, 45*time.Second)
	data, err := os.ReadFile(filepath.Join(root, "downloads", "payload.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, payload) {
		t.Fatalf("reloaded download bytes=%d, want %d", len(data), len(payload))
	}
}

func waitForManagerStatus(t *testing.T, manager *downloader.Manager, id int64, want downloader.Status, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var last *downloader.Task
	for time.Now().Before(deadline) {
		last, _ = manager.GetTask(id)
		if last != nil && last.Status == want {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("task %d did not reach %s; last=%+v", id, want, last)
}
