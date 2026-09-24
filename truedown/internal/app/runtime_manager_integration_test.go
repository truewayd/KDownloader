package app

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"truedown/internal/downloader"
	"truedown/internal/systemupdate"
)

func TestManagerHostReloadsStableEngineInProcess(t *testing.T) {
	if os.Getenv("TRUEDOWN_INTEGRATION") != "1" {
		t.Skip("set TRUEDOWN_INTEGRATION=1 to run the aria2 integration test")
	}
	aria2Path, err := integrationAria2Path()
	if err != nil {
		t.Skipf("aria2 executable unavailable: %v", err)
	}
	root := t.TempDir()
	payload := bytes.Repeat([]byte("TrueDown warm engine switch\n"), 32*1024)
	release := make(chan struct{})
	var releaseOnce sync.Once
	finishTransfer := func() { releaseOnce.Do(func() { close(release) }) }
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reader := &reloadPayloadReader{Reader: bytes.NewReader(payload), ctx: r.Context(), release: release}
		http.ServeContent(w, r, "payload.bin", time.Time{}, reader)
	}))
	defer server.Close()
	defer finishTransfer()
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
	task, duplicate, err := manager.AddTask(server.URL+"/payload.bin", "payload.bin", "", nil, "", 0, downloader.Aria2Opts{Connections: 1})
	if err != nil || duplicate {
		t.Fatalf("add integration task: task=%+v duplicate=%v err=%v", task, duplicate, err)
	}
	waitForManagerStatus(t, manager, task.ID, downloader.StatusDownloading, 10*time.Second)
	deadline := time.Now().Add(10 * time.Second)
	for {
		current, _ := manager.GetTask(task.ID)
		if current != nil && current.CompletedLength > 0 && current.CompletedLength < int64(len(payload)) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("task did not persist partial progress before reload: %+v", current)
		}
		time.Sleep(100 * time.Millisecond)
	}
	paused, duplicate, err := manager.AddTask(server.URL+"/payload.bin", "paused.bin", "", nil, "", 0, downloader.Aria2Opts{Connections: 1})
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
	finishTransfer()
	waitForManagerStatus(t, reloaded, task.ID, downloader.StatusDone, 45*time.Second)
	data, err := os.ReadFile(filepath.Join(task.Folder, "payload.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, payload) {
		t.Fatalf("reloaded download bytes=%d, want %d", len(data), len(payload))
	}
}

// Serve a real partial payload, then wait for the engine reload. Cancellation
// releases old engine requests; resumed HTTP ranges remain supported by Seek.
type reloadPayloadReader struct {
	*bytes.Reader
	ctx     context.Context
	release <-chan struct{}
}

func (reader *reloadPayloadReader) Read(p []byte) (int, error) {
	if reader.Size()-int64(reader.Len()) >= 32*1024 {
		select {
		case <-reader.release:
		case <-reader.ctx.Done():
			return 0, reader.ctx.Err()
		}
	}
	if len(p) > 32*1024 {
		p = p[:32*1024]
	}
	return reader.Reader.Read(p)
}

func integrationAria2Path() (string, error) {
	if runtime.GOOS != "windows" {
		return exec.LookPath("aria2c")
	}
	return filepath.Abs(filepath.Join("..", "..", "aria2", "aria2c.exe"))
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
