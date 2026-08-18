package downloader

import (
	"fmt"
	"path/filepath"
	"testing"
)

func TestAddTasksBatchCreatesFreshTasksAndPreservesDuplicates(t *testing.T) {
	root := t.TempDir()
	manager, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Stop()
	requests := make([]taskAddRequest, 101)
	for index := 0; index < 100; index++ {
		requests[index] = taskAddRequest{
			Link: fmt.Sprintf("https://example.test/file-%03d.bin", index),
			Name: fmt.Sprintf("file-%03d.bin", index),
		}
	}
	requests[100] = requests[0]
	results, err := manager.addTasksBatch(requests)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 101 || len(manager.ListTasks()) != 100 || !results[100].Duplicate ||
		results[100].Task.ID != results[0].Task.ID {
		t.Fatalf("unexpected batch results: results=%d tasks=%d duplicate=%+v", len(results), len(manager.ListTasks()), results[100])
	}
}

func TestAddTasksBatchValidatesBeforeCreatingAnything(t *testing.T) {
	root := t.TempDir()
	manager, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Stop()
	_, err = manager.addTasksBatch([]taskAddRequest{
		{Link: "https://example.test/good", Name: "good.bin"},
		{Link: "file:///invalid", Name: "bad.bin"},
	})
	if !IsValidationError(err) || len(manager.ListTasks()) != 0 {
		t.Fatalf("batch validation err=%v tasks=%d", err, len(manager.ListTasks()))
	}
}
