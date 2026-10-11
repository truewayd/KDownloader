package downloader

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLiveArtifactQueue(t *testing.T) {
	source := os.Getenv("TRUEDOWN_MEGA_TEST_LINK")
	directory := os.Getenv("TRUEDOWN_MEGA_TEST_MODULE_DIRECTORY")
	if source == "" || (directory == "" && os.Getenv("TRUEDOWN_MEGA_TEST_BUNDLE") != "1") {
		t.Skip("explicit public fixture and module directory required")
	}
	engine, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	root := artifactTempDir(t)
	config := integrationManagerConfig()
	config.ModuleDirectory = directory
	m, err := NewManagerWithConfig(engine, filepath.Join(root, "downloads"), filepath.Join(root, "records.db"), config)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	opts := Aria2Opts{Connections: 1, MaxTries: 1, ProxyMode: "custom", ExtraArgs: []string{"--all-proxy=" + os.Getenv("TRUEDOWN_MEGA_TEST_HTTP_PROXY")}}
	task, _, err := m.AddTask(source, "", "", nil, "", 0, opts.WithStartPaused(true))
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != StatusPaused {
		t.Fatal("paused admission lost")
	}
	time.Sleep(2 * time.Second)
	if err := m.ResumeTask(task.ID); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Minute)
	for time.Now().Before(deadline) {
		current, _ := m.GetTask(task.ID)
		if current.Status == StatusError {
			m.artifacts.mu.Lock()
			for _, job := range m.artifacts.jobs {
				t.Logf("artifact diagnostic: %v", job.failure)
			}
			m.artifacts.mu.Unlock()
			t.Fatalf("artifact queue failed: %s", current.Error)
		}
		if current.Status == StatusDone {
			data, err := os.ReadFile(filepath.Join(current.Folder, current.OutputName))
			if err != nil {
				t.Fatal(err)
			}
			hash := sha256.Sum256(data)
			if hex.EncodeToString(hash[:]) != os.Getenv("TRUEDOWN_MEGA_TEST_SHA256") {
				t.Fatal("published bytes differ from fixture")
			}
			t.Logf("queue published verified file: %d bytes", len(data))
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("queue completion deadline")
}
