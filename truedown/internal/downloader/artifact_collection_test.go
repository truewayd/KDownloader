package downloader

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"truedown/internal/modulehost"
)

func TestAriaCollectionRestartPauseAndRemoval(t *testing.T) {
	if os.Getenv("TRUEDOWN_INTEGRATION") == "" {
		t.Skip("real aria2 integration opt-in")
	}
	modules, data := artifactHelper(t)
	encrypted := bytes.Clone(data)
	for i := range encrypted {
		encrypted[i] ^= 0xaa
	}
	var resumed atomic.Bool
	var firstMemberRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/fixture.bin" {
			firstMemberRequests.Add(1)
		}
		if value := r.Header.Get("Range"); value != "" && !strings.HasPrefix(value, "bytes=0-") {
			resumed.Store(true)
		}
		http.ServeContent(w, r, "ciphertext", time.Unix(1700000000, 0), bytes.NewReader(encrypted))
	}))
	defer server.Close()
	t.Setenv("TRUEDOWN_TEST_ARTIFACT_URL", server.URL)
	engine, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	root := artifactTempDir(t)
	config := integrationManagerConfig()
	config.ModuleDirectory = modules
	newManager := func() *Manager {
		m, err := NewManagerWithConfig(engine, filepath.Join(root, "downloads"), filepath.Join(root, "records.db"), config)
		if err != nil {
			t.Fatal(err)
		}
		if err := m.Start(); err != nil {
			m.Stop()
			t.Fatal(err)
		}
		return m
	}
	m := newManager()
	defer func() { m.Stop() }()
	opts := Aria2Opts{Connections: 1, MaxSpeedBps: 512 * 1024, ProxyMode: "none"}.WithStartPaused(true)
	result, _, err := m.AddWithModules(context.Background(), "https://mega.nz/folder/fixture#fixture", "", "", nil, "", 0, opts, nil)
	if err != nil || len(result.Tasks) != 1 {
		t.Fatalf("collection admission: %+v %v", result, err)
	}
	task := result.Tasks[0]
	if task.Status != StatusPaused {
		t.Fatal("initial pause lost")
	}
	if err := m.ResumeTask(task.ID); err != nil {
		t.Fatal(err)
	}
	current := waitForCollectionBytes(t, m, task.ID, int64(len(data))+256*1024)
	if err := m.PauseTask(task.ID); err != nil {
		t.Fatal(err)
	}
	waitForStatus(t, m, task.ID, 3*time.Second, StatusPaused)
	if _, err := os.Stat(filepath.Join(current.Folder, current.OutputName)); !os.IsNotExist(err) {
		t.Fatal("ZIP published before all members were verified")
	}
	m.Stop()
	completedRequests := firstMemberRequests.Load()
	if completedRequests == 0 {
		t.Fatal("first collection member was not transferred")
	}
	m = newManager()
	if err := m.ResumeTask(task.ID); err != nil {
		t.Fatal(err)
	}
	waitForStatus(t, m, task.ID, 30*time.Second, StatusDone)
	current, _ = m.GetTask(task.ID)
	if !resumed.Load() {
		t.Fatal("collection restart did not resume a member with Range")
	}
	if firstMemberRequests.Load() != completedRequests {
		t.Fatal("collection restart downloaded an already completed member")
	}
	archivePath := filepath.Join(current.Folder, current.OutputName)
	archive, err := zip.OpenReader(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	if len(archive.File) != 3 || archive.File[0].Name != "empty/" {
		t.Fatal("folder hierarchy or empty directory changed")
	}
	for _, member := range archive.File[1:] {
		reader, err := member.Open()
		if err != nil {
			t.Fatal(err)
		}
		actual, err := io.ReadAll(reader)
		reader.Close()
		if err != nil || !bytes.Equal(actual, data) {
			t.Fatal("resumed ZIP member differs from the verified fixture")
		}
	}
	archive.Close()
	if err := singleOperationError(m.RemoveTasks([]int64{task.ID}), task.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(archivePath); err != nil {
		t.Fatal("removing a completed ZIP task deleted its output")
	}
	result, _, err = m.AddWithModules(context.Background(), "https://mega.nz/folder/fixture#fixture", "cancelled.zip", "", nil, "", 0, opts, nil)
	if err != nil || len(result.Tasks) != 1 {
		t.Fatalf("second collection admission: %+v %v", result, err)
	}
	task = result.Tasks[0]
	if err := m.ResumeTask(task.ID); err != nil {
		t.Fatal(err)
	}
	current = waitForCollectionBytes(t, m, task.ID, 256*1024)
	if err := singleOperationError(m.RemoveTasks([]int64{task.ID}), task.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(current.Folder, current.OutputName)); !os.IsNotExist(err) {
		t.Fatal("removal published a partial ZIP")
	}
	if _, err := os.Stat(filepath.Join(artifactDirectory(current), modulehost.CiphertextName(1))); !os.IsNotExist(err) {
		t.Fatal("removal retained an owned partial member")
	}
}

func waitForCollectionBytes(t *testing.T, m *Manager, id int64, minimum int64) *Task {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		current, _ := m.GetTask(id)
		if current.Status == StatusError {
			t.Fatalf("collection transport failed: %s", current.Error)
		}
		if current.CompletedLength >= minimum {
			return current
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("no partial collection checkpoint")
	return nil
}
