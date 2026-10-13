package downloader

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Public fixtures are explicit, bounded and never committed or logged with keys.
func TestLiveMegaFolderModes(t *testing.T) {
	source := os.Getenv("TRUEDOWN_MEGA_FOLDER_TEST_LINK")
	if source == "" {
		t.Skip("explicit small public folder fixture required")
	}
	engine, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	root := artifactTempDir(t)
	m, err := NewManagerWithConfig(engine, filepath.Join(root, "downloads"), filepath.Join(root, "records.db"), integrationManagerConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	opts := Aria2Opts{Connections: 1, MaxTries: 1, ProxyMode: "custom", ExtraArgs: []string{"--all-proxy=" + os.Getenv("TRUEDOWN_MEGA_TEST_HTTP_PROXY")}}.WithStartPaused(true)
	archive, handled, err := m.AddWithModules(ctx, source, "", "", nil, "", 0, opts, map[string]json.RawMessage{"mega": json.RawMessage(`{"mode":"archive"}`)})
	if err != nil || !handled || len(archive.Tasks) != 1 {
		t.Fatalf("folder archive admission: handled=%v tasks=%d err=%v", handled, len(archive.Tasks), err)
	}
	var identity requestIdentity
	if json.Unmarshal([]byte(archive.Tasks[0].RequestJSON), &identity) != nil || identity.Collection == nil {
		t.Fatal("missing durable folder identity")
	}
	var total int64
	expectedFiles := 0
	for _, entry := range identity.Collection.Entries {
		total += entry.Size
		if !entry.Directory {
			expectedFiles++
		}
	}
	if total > 20*1024*1024 || expectedFiles < 2 {
		t.Fatal("fixture must contain multiple small files")
	}
	if archive.Tasks[0].Status != StatusPaused {
		t.Fatal("paused ZIP intent lost")
	}
	if err := m.ResumeTask(archive.Tasks[0].ID); err != nil {
		t.Fatal(err)
	}
	finished := waitLiveMegaTask(t, m, archive.Tasks[0].ID)
	reader, err := zip.OpenReader(filepath.Join(finished.Folder, finished.OutputName))
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	contents := map[string][]byte{}
	for _, file := range reader.File {
		if file.FileInfo().IsDir() {
			continue
		}
		input, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(io.LimitReader(input, 20*1024*1024+1))
		input.Close()
		if err != nil {
			t.Fatal("invalid ZIP entry", err)
		}
		contents[file.Name] = data
	}
	if len(contents) != expectedFiles {
		t.Fatal("ZIP omitted files")
	}
	if _, err := m.SetDownloadRules(DownloadRules{FilterMode: DropboxFilterCustom, ExcludedExtensions: []string{".PDF"}, MegaMode: MegaModeExpand}); err != nil {
		t.Fatal(err)
	}
	expanded, handled, err := m.AddWithModules(ctx, source, "", "", nil, "", 0, opts, nil)
	if err != nil || !handled || expanded.Filtered != 1 || len(expanded.Tasks) != expectedFiles-1 {
		t.Fatalf("shared filter: handled=%v tasks=%d filtered=%d err=%v", handled, len(expanded.Tasks), expanded.Filtered, err)
	}
	for _, task := range expanded.Tasks {
		if task.Status != StatusPaused {
			t.Fatal("expanded pause intent lost")
		}
		if err := m.ResumeTask(task.ID); err != nil {
			t.Fatal(err)
		}
		current := waitLiveMegaTask(t, m, task.ID)
		data, err := os.ReadFile(filepath.Join(current.Folder, current.OutputName))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(data, contents[task.Name]) {
			t.Fatal("expanded plaintext differs from ZIP", task.Name)
		}
	}
	// A direct child link bypasses the folder filter and still verifies its MAC.
	for _, entry := range identity.Collection.Entries {
		if !strings.HasSuffix(strings.ToLower(strings.Join(entry.Path, "/")), ".pdf") {
			continue
		}
		one, _, err := m.AddWithModules(ctx, entry.Source, "", "", nil, "", 0, opts, nil)
		if err != nil || len(one.Tasks) != 1 {
			t.Fatal("direct folder-child admission failed", err)
		}
		if err := m.ResumeTask(one.Tasks[0].ID); err != nil {
			t.Fatal(err)
		}
		current := waitLiveMegaTask(t, m, one.Tasks[0].ID)
		data, err := os.ReadFile(filepath.Join(current.Folder, current.OutputName))
		if err != nil || !bytes.Equal(data, contents[strings.Join(entry.Path, "/")]) || !bytes.HasPrefix(data, []byte("%PDF-")) {
			t.Fatal("direct PDF plaintext or signature differs", err)
		}
	}
	for name, data := range contents {
		t.Logf("verified ZIP plaintext: %s bytes=%d sha256=%x", name, len(data), sha256.Sum256(data))
	}
	t.Logf("public folder accepted: ZIP files=%d, expanded=%d, filtered=%d, ZIP bytes=%d", len(contents), len(expanded.Tasks), expanded.Filtered, finished.TotalLength)
}

func waitLiveMegaTask(t *testing.T, m *Manager, id int64) *Task {
	t.Helper()
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		task, ok := m.GetTask(id)
		if !ok {
			t.Fatal("live task disappeared")
		}
		if task.Status == StatusDone {
			return task
		}
		if task.Status == StatusError {
			m.artifacts.mu.Lock()
			for _, job := range m.artifacts.jobs {
				if job.task.ID == id {
					t.Logf("artifact failure: %v", job.failure)
				}
			}
			m.artifacts.mu.Unlock()
			t.Fatal("live task failed", task.Error)
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("live task completion deadline")
	return nil
}
