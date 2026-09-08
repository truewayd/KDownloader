package downloader

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestGroupDirectoriesPreserveLegacyPathsAndPinNewTasks(t *testing.T) {
	root := t.TempDir()
	db := filepath.Join(root, "records.db")
	m, err := NewManager("unused", root, db)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	// Seed a pre-grouping record. Its unchanged request identity must still
	// deduplicate after the new default directories become available.
	identity := normalizeRequest("https://example.test/old.png", "old.png", root, root, nil, "", 0, Aria2Opts{})
	encoded, _ := json.Marshal(identity)
	hash := sha256.Sum256(encoded)
	legacy := &Task{ID: 1, Name: identity.Name, Link: identity.Link, Folder: root, RequestJSON: string(encoded), Fingerprint: hex.EncodeToString(hash[:]), Status: StatusPaused, GID: newGID(), CreatedAt: time.Now(), UpdatedAt: time.Now()}
	if err := m.store.InsertBatch([]*Task{legacy}); err != nil {
		t.Fatal(err)
	}
	m.Stop()
	m, err = NewManager("unused", root, db)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	old, duplicate, err := m.AddTask(identity.Link, identity.Name, root, nil, "", 0, Aria2Opts{})
	if err != nil || !duplicate || old.Folder != root {
		t.Fatalf("legacy path changed: %+v, %v", old, err)
	}
	for name, directory := range map[string]string{"photo.PNG": "Pictures", "film.mp4": "Videos", "song.mp3": "Music", "files.tar.gz": "Archives", "setup.exe": "Applications", "readme.pdf": "Documents", "source.PSD": "Projects", "unknown.bin": "Other"} {
		task, _, err := m.AddTask("https://example.test/"+name, name, root, nil, "", 0, Aria2Opts{})
		if err != nil || task.Folder != filepath.Join(root, directory) {
			t.Fatalf("%s: %+v, %v", name, task, err)
		}
	}
	groups := m.FileGroups()
	groups.Groups[0].Directory = "Photos"
	if _, err := m.SetFileGroups(groups.Revision, groups.Groups); err != nil {
		t.Fatal(err)
	}
	pinned, duplicate, err := m.AddTask("https://example.test/photo.PNG", "photo.PNG", root, nil, "", 0, Aria2Opts{})
	if err != nil || !duplicate || pinned.Folder != filepath.Join(root, "Pictures") {
		t.Fatalf("existing task moved: %+v, %v", pinned, err)
	}
	fresh, _, err := m.AddTask("https://example.test/new.png", "new.png", root, nil, "", 0, Aria2Opts{})
	if err != nil || fresh.Folder != filepath.Join(root, "Photos") {
		t.Fatalf("new directory not applied: %+v, %v", fresh, err)
	}
	unnamed, _, err := m.AddTask("https://example.test/content", "", root, nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	m.flushAdmissions(false)
	resolved, err := m.applyRemoteMetadata(unnamed.ID, remoteMetadata{Name: "picture.png"}, false, "Fixture")
	if err != nil || resolved.Folder != filepath.Join(root, "Photos") {
		t.Fatalf("resolved name did not select its directory: %+v, %v", resolved, err)
	}
	m.Stop()
	m, err = NewManager("unused", root, db)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	restored, _ := m.GetTask(unnamed.ID)
	if restored.Folder != resolved.Folder {
		t.Fatalf("resolved directory was not persisted: %+v", restored)
	}
}

func TestGroupDirectoriesRejectTraversalAndMigrateMissingNames(t *testing.T) {
	for _, directory := range []string{"../escape", `a\b`, "/tmp", "C:", "..", ".", "NUL", "a.", "a\x00b"} {
		groups := defaultFileGroups().Groups
		groups[0].Directory = directory
		if _, err := normalizeFileGroups(groups); err == nil {
			t.Fatalf("unsafe directory accepted: %q", directory)
		}
	}
	groups := defaultFileGroups().Groups
	groups[0].Directory, groups[0].Name = "", "Renamed images"
	groups = append(groups, FileGroup{ID: "custom", Name: "Design sources", Extensions: []string{".custom"}})
	saved, err := normalizeFileGroups(groups)
	if err != nil || saved[0].Directory != "Pictures" || saved[len(saved)-1].Directory != "Design sources" {
		t.Fatalf("migration: %+v, %v", saved, err)
	}
}

func TestGroupDirectoriesWriteActualFilesWithAria2(t *testing.T) {
	if os.Getenv("TRUEDOWN_INTEGRATION") == "" {
		t.Skip("set TRUEDOWN_INTEGRATION=1")
	}
	engine, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte("verified grouped download bytes\n")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(payload) }))
	defer server.Close()
	root := t.TempDir()
	m, err := NewManager(engine, filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	for name, directory := range map[string]string{"photo.PNG": "Pictures", "film.mp4": "Videos", "song.mp3": "Music", "files.tar.gz": "Archives", "setup.exe": "Applications", "readme.pdf": "Documents", "source.PSD": "Projects", "unknown.bin": "Other"} {
		task, _, err := m.AddTask(server.URL+"/"+name, name, "", nil, "", 0, Aria2Opts{})
		if err != nil {
			t.Fatal(err)
		}
		waitForStatus(t, m, task.ID, 10*time.Second, StatusDone)
		expected := filepath.Join(root, "downloads", directory, name)
		actual, err := os.ReadFile(expected)
		if err != nil || !bytes.Equal(actual, payload) {
			t.Fatalf("file not saved under %s: %v", expected, err)
		}
		if _, err := os.Stat(filepath.Join(root, "downloads", name)); !os.IsNotExist(err) {
			t.Fatalf("ungrouped output exists: %v", err)
		}
	}
}
