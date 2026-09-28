package downloader

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func TestInitialPausePersistsWithoutChangingDuplicateIdentity(t *testing.T) {
	root := t.TempDir()
	database := filepath.Join(root, "records.db")
	folder := filepath.Join(root, "downloads")
	manager, err := NewManager("unused", folder, database)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Stop()
	opts := Aria2Opts{}.WithStartPaused(true)
	task, duplicate, err := manager.AddTask("https://example.test/file", "file.bin", "", nil, "", 0, opts)
	if err != nil || duplicate || task.Status != StatusPaused {
		t.Fatalf("task=%+v duplicate=%v err=%v", task, duplicate, err)
	}
	if options := ariaOptions(task, false); options["pause"] != "true" {
		t.Fatalf("options=%v", options)
	}
	same, duplicate, err := manager.AddTask(task.Link, "file.bin", "", nil, "", 0, Aria2Opts{})
	if err != nil || !duplicate || same.ID != task.ID || same.Status != StatusPaused {
		t.Fatalf("duplicate changed paused task: %+v %v", same, err)
	}
	encoded, err := json.Marshal(task)
	if err != nil || strings.Contains(strings.ToLower(string(encoded)), "startpaused") {
		t.Fatalf("admission intent leaked: %s %v", encoded, err)
	}
	batch, err := manager.addTasksBatch([]taskAddRequest{{Link: "https://example.test/batch", Name: "batch.bin", Opts: opts}})
	if err != nil || len(batch) != 1 || batch[0].Task.Status != StatusPaused {
		t.Fatalf("batch=%+v err=%v", batch, err)
	}
	manager.Stop()
	reloaded, err := NewManager("unused", folder, database)
	if err != nil {
		t.Fatal(err)
	}
	defer reloaded.Stop()
	if tasks := reloaded.ListTasks(); len(tasks) != 2 {
		t.Fatalf("reloaded tasks=%+v", tasks)
	} else {
		for _, task := range tasks {
			if task.Status != StatusPaused {
				t.Fatalf("pause lost on restart: %+v", task)
			}
		}
	}
}
