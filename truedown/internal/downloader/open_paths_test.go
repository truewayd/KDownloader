package downloader

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOpenPathsUseOnlyManagerOwnedTaskPaths(t *testing.T) {
	root := t.TempDir()
	downloads := filepath.Join(root, "downloads")
	manager, err := NewManager("unused", downloads, filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Stop()
	var opened []string
	manager.openPath = func(path string) error {
		opened = append(opened, path)
		return nil
	}
	if err := manager.OpenDownloadDirectory(); err != nil {
		t.Fatal(err)
	}
	task, _, err := manager.AddTask("https://example.test/file.bin", "file.bin", "", nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.OpenTaskFile(task.ID); !IsValidationError(err) {
		t.Fatalf("active task open error=%v", err)
	}
	if err := manager.OpenTaskDirectory(task.ID); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(task.Folder, task.OutputName), []byte("done"), 0600); err != nil {
		t.Fatal(err)
	}
	manager.mu.Lock()
	manager.setStatusLocked(manager.tasks[task.ID], StatusDone)
	manager.mu.Unlock()
	if err := manager.OpenTaskFile(task.ID); err != nil {
		t.Fatal(err)
	}
	if len(opened) != 3 || opened[0] != downloads || opened[1] != task.Folder || opened[2] != filepath.Join(task.Folder, task.OutputName) {
		t.Fatalf("opened paths=%v", opened)
	}
}
