package downloader

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"truedown/internal/profile"
)

func TestNativeDiagnosticsUseResolvedLogRole(t *testing.T) {
	manager := &Manager{aria2Next: true, aria2NextVersion: "2.6.5", defaultDir: filepath.Join(t.TempDir(), "downloads"), logDir: filepath.Join(t.TempDir(), "logs")}
	args := manager.aria2StartArgs(15152, "fixture", defaultRuntimeSettings())
	want := "--log=" + filepath.ToSlash(filepath.Join(manager.logDir, profile.AriaLog))
	if !slices.Contains(args, want) {
		t.Fatal("native diagnostics escaped the resolved log role")
	}
}

func TestProfileCheckpointFlushesRealSQLiteWAL(t *testing.T) {
	path := filepath.Join(t.TempDir(), "truedown.db")
	db, err := openSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, statement := range []string{"PRAGMA journal_mode=WAL", "CREATE TABLE migration_probe (value TEXT)", "INSERT INTO migration_probe VALUES ('durable task')"} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if info, err := os.Stat(path + "-wal"); err != nil || info.Size() == 0 {
		t.Fatal("WAL fixture missing", err)
	}
	if err := CheckpointForProfileMigration(path); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(path + "-wal"); err == nil && info.Size() != 0 {
		t.Fatal("WAL remains uncheckpointed")
	}
	rows, err := db.Query("SELECT value FROM migration_probe")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	ready, err := rows.Next()
	if err != nil || !ready || rows.Text(0) != "durable task" {
		t.Fatal("checkpoint lost rows", err)
	}
}

func TestProfileMigrationPreservesTaskRecordsAndPartialFiles(t *testing.T) {
	root := t.TempDir()
	store, err := openRecordStore(filepath.Join(root, profile.Database))
	if err != nil {
		t.Fatal(err)
	}
	folder := filepath.Join(root, "downloads")
	os.Mkdir(folder, 0700)
	os.WriteFile(filepath.Join(folder, "paused.bin"), []byte("partial download"), 0600)
	tasks := []*Task{
		{ID: 7, Name: "paused.bin", Link: "https://example.com/paused.bin", Folder: folder, OutputName: "paused.bin", Status: StatusPaused, Fingerprint: "paused-fixture", GID: "0000000000000007", Revision: 12, Headers: map[string]string{"Authorization": "fixture-only"}},
		{ID: 8, Name: "done.bin", Link: "https://example.com/done.bin", Folder: folder, OutputName: "done.bin", Status: StatusDone, Fingerprint: "done-fixture", Revision: 20},
	}
	if err := store.InsertBatch(tasks); err != nil {
		store.Close()
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	location, err := profile.Resolve(root, root)
	if err != nil {
		t.Fatal(err)
	}
	location, err = profile.Initialize(context.Background(), location, CheckpointForProfileMigration)
	if err != nil {
		t.Fatal(err)
	}
	store, err = openRecordStore(location.Paths.File(profile.Database))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	restored, err := store.LoadAll()
	if err != nil || len(restored) != 2 {
		t.Fatal(restored, err)
	}
	for _, actual := range restored {
		want := tasks[actual.ID-7]
		if actual.Status != want.Status || actual.GID != want.GID || actual.Revision != want.Revision || actual.Folder != want.Folder {
			t.Fatalf("task changed: %+v", actual)
		}
	}
	if data, err := os.ReadFile(filepath.Join(folder, "paused.bin")); err != nil || string(data) != "partial download" {
		t.Fatal("partial data changed", err)
	}
}
