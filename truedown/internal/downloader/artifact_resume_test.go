package downloader

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestAriaArtifactRestartResumesCiphertext(t *testing.T) {
	if os.Getenv("TRUEDOWN_INTEGRATION") == "" {
		t.Skip("real aria2 integration opt-in")
	}
	modules, data := artifactHelper(t)
	encrypted := append([]byte(nil), data...)
	for i := range encrypted {
		encrypted[i] ^= 0xaa
	}
	var resumed atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
	task, _, err := m.AddTask("https://mega.nz/file/fixture#fixture", "", "", nil, "", 0, Aria2Opts{Connections: 1, MaxSpeedBps: 256 * 1024, ProxyMode: "none"})
	if err != nil {
		m.Stop()
		t.Fatal(err)
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		current, _ := m.GetTask(task.ID)
		if current.CompletedLength > 256*1024 {
			break
		}
		if current.Status == StatusError {
			m.Stop()
			t.Fatal(current.Error)
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err := m.PauseTask(task.ID); err != nil {
		m.Stop()
		t.Fatal(err)
	}
	current, _ := m.GetTask(task.ID)
	if current.CompletedLength == 0 {
		m.Stop()
		t.Fatal("no partial checkpoint")
	}
	if _, err := os.Stat(filepath.Join(current.Folder, current.OutputName)); !os.IsNotExist(err) {
		m.Stop()
		t.Fatal("plaintext published before verification")
	}
	m.Stop()
	m = newManager()
	defer m.Stop()
	if err := m.ResumeTask(task.ID); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(25 * time.Second)
	for time.Now().Before(deadline) {
		current, _ = m.GetTask(task.ID)
		if current.Status == StatusError {
			t.Fatal(current.Error)
		}
		if current.Status == StatusDone {
			if !resumed.Load() {
				t.Fatal("restart fetched from zero")
			}
			hash, err := artifactHash(filepath.Join(current.Folder, current.OutputName), int64(len(data)))
			want := sha256.Sum256(data)
			if err != nil || hash != hex.EncodeToString(want[:]) {
				t.Fatalf("resumed publication: %v", err)
			}
			cleanupDeadline := time.Now().Add(2 * time.Second)
			for {
				_, err := os.Stat(filepath.Join(artifactDirectory(current), "ciphertext"))
				if os.IsNotExist(err) {
					break
				}
				if time.Now().After(cleanupDeadline) {
					t.Fatal("durable completion retained ciphertext")
				}
				time.Sleep(20 * time.Millisecond)
			}
			if err := singleOperationError(m.RemoveTasks([]int64{task.ID}), task.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(filepath.Join(current.Folder, current.OutputName)); err != nil {
				t.Fatal("removal deleted completed output")
			}
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("resume deadline")
}
