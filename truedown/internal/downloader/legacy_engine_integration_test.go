package downloader

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestOlderEngineRetainsMediaWithoutBlockingHTTPIntegration(t *testing.T) {
	config := integrationManagerConfig()
	if os.Getenv("TRUEDOWN_INTEGRATION") == "" || !config.Aria2Next || aria2NextVersionAtLeast(config.Aria2NextVersion, 3, 0, 0) {
		t.Skip("requires an older NEXT engine")
	}
	engine, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	m, err := NewManagerWithConfig(engine, filepath.Join(root, "downloads"), filepath.Join(root, "records.db"), config)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	concurrency := 1
	if _, err := m.UpdateRuntimeSettings(RuntimeSettingsUpdate{ConcurrentDownloads: &concurrency}); err != nil {
		t.Fatal(err)
	}
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	var requests atomic.Int32
	var mediaRequests atomic.Int32
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.URL.Path != "/file" {
			mediaRequests.Add(1)
		}
		http.ServeContent(w, r, "file.bin", time.Unix(1000, 0), bytes.NewReader([]byte("ordinary HTTP")))
	}))
	defer source.Close()
	if _, err := m.ProbeLink(context.Background(), source.URL+"/file", nil, "", Aria2Opts{}); !errors.Is(err, ErrProbeUnavailable) || requests.Load() != 0 {
		t.Fatal("legacy probe created network activity", err)
	}
	var mediaIDs []int64
	for _, paused := range []bool{false, true} {
		opts := Aria2Opts{Media: &MediaOptions{Protocol: "hls"}}
		opts = opts.WithStartPaused(paused)
		name := "Auto"
		if paused {
			name = "Paused"
		}
		task, _, err := m.AddTask(source.URL+"/"+name, name, "", nil, "", 0, opts)
		if err != nil {
			t.Fatal(err)
		}
		mediaIDs = append(mediaIDs, task.ID)
	}
	file, _, err := m.AddTask(source.URL+"/file", "file.bin", "", nil, "", 0, Aria2Opts{Connections: 1})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(15 * time.Second)
	for {
		current, _ := m.GetTask(file.ID)
		if current.Status == StatusDone {
			break
		}
		if current.Status == StatusError || time.Now().After(deadline) {
			t.Fatal("waiting media blocked ordinary HTTP", current)
		}
		time.Sleep(20 * time.Millisecond)
	}
	for index, id := range mediaIDs {
		task, _ := m.GetTask(id)
		wanted := StatusQueued
		if index == 1 {
			wanted = StatusPaused
		}
		if task.Status != wanted || !m.snapshotTask(task).RequiresMediaEngine {
			t.Fatal("lost waiting state or pause intent", task)
		}
		if _, err := m.rpc.status(task.GID); !isGIDNotFound(err) {
			t.Fatal("media reached old engine", err)
		}
	}
	if mediaRequests.Load() != 0 {
		t.Fatal("media playlist was fetched as ordinary output", mediaRequests.Load())
	}
	removed := m.RemoveTasks(mediaIDs)
	if len(removed.Succeeded) != 2 {
		t.Fatal("waiting tasks could not be removed", removed)
	}
	completed, _ := m.GetTask(file.ID)
	if data, err := os.ReadFile(filepath.Join(completed.Folder, completed.OutputName)); err != nil || string(data) != "ordinary HTTP" {
		t.Fatal("ordinary output changed", err)
	}
}
