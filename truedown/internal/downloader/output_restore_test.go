package downloader

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func restoredOverlappingTasks(t *testing.T) (*Manager, []*Task) {
	return restoredOverlappingTasksWith(t, nil)
}

func restoredOverlappingTasksWith(t *testing.T, prepare func([]*Task)) (*Manager, []*Task) {
	t.Helper()
	base := artifactTempDir(t)
	downloads, database := filepath.Join(base, "downloads"), filepath.Join(base, "records.db")
	m, err := NewManager("unused", downloads, database)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Stop)
	var tasks []*Task
	for _, name := range []string{"first.bin", "second.bin"} {
		task, _, err := m.AddTask("https://example.test/"+name, name, "", nil, "", 0, Aria2Opts{})
		if err != nil {
			t.Fatal(err)
		}
		tasks = append(tasks, task)
	}
	m.flushAdmissions(false)
	tasks[1].OutputName, tasks[1].Folder = tasks[0].OutputName, tasks[0].Folder
	if prepare != nil {
		prepare(tasks)
	}
	if err := m.store.UpdateRequest(tasks[0]); err != nil {
		t.Fatal(err)
	}
	if err := m.store.UpdateRequest(tasks[1]); err != nil {
		t.Fatal(err)
	}
	m.Stop()
	m, err = NewManager("unused", downloads, database)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Stop)
	m.rpc = &fakeAriaRPC{}
	return m, tasks
}

func TestRestoredOverlappingOutputsProtectEveryOwner(t *testing.T) {
	for _, chosen := range []int{0, 1} {
		t.Run([]string{"first", "last"}[chosen], func(t *testing.T) {
			m, tasks := restoredOverlappingTasks(t)
			task := tasks[chosen]
			if err := os.MkdirAll(task.Folder, 0700); err != nil {
				t.Fatal(err)
			}
			for _, suffix := range []string{"", ".aria2"} {
				if err := os.WriteFile(filepath.Join(task.Folder, task.OutputName+suffix), []byte("shared"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			result := m.RemoveTasks([]int64{task.ID})
			if len(result.Failed) != 1 || len(result.Succeeded) != 0 {
				t.Fatalf("shared output removed: %+v", result)
			}
			stored, err := m.store.LoadAll()
			if err != nil || len(stored) != 2 {
				t.Fatalf("shared owners lost: %v %v", stored, err)
			}
			for _, suffix := range []string{"", ".aria2"} {
				if data, err := os.ReadFile(filepath.Join(task.Folder, task.OutputName+suffix)); err != nil || string(data) != "shared" {
					t.Fatalf("shared bytes changed: %q %v", data, err)
				}
			}
		})
	}
}

func TestRemovingOrReassigningOneOwnerPreservesOtherReservation(t *testing.T) {
	for _, reassign := range []bool{false, true} {
		t.Run(map[bool]string{false: "delete", true: "reassign"}[reassign], func(t *testing.T) {
			m, tasks := restoredOverlappingTasks(t)
			m.mu.Lock()
			if reassign {
				replacement := cloneTask(m.tasks[tasks[1].ID])
				replacement.OutputName = "new.bin"
				m.replaceTaskLocked(m.tasks[replacement.ID], replacement)
			} else {
				m.removeTaskLocked(tasks[1].ID)
			}
			owner, conflict := m.conflictingOutputOwnerLocked(tasks[0].Folder, tasks[0].OutputName, 0)
			m.mu.Unlock()
			if !conflict || owner != tasks[0].ID {
				t.Fatal("remaining owner lost its reservation")
			}
		})
	}
}

func TestCleanupPreservesFilesWhenAnotherOwnerCannotBeInspected(t *testing.T) {
	m, tasks := restoredOverlappingTasksWith(t, func(tasks []*Task) {
		folder := tasks[0].Folder
		if err := os.MkdirAll(folder, 0700); err != nil {
			t.Fatal(err)
		}
		blocked := filepath.Join(folder, "not-a-directory")
		if err := os.WriteFile(blocked, []byte("blocker"), 0600); err != nil {
			t.Fatal(err)
		}
		tasks[1].Folder = blocked
	})
	task := tasks[0]
	path := filepath.Join(task.Folder, task.OutputName)
	if err := os.WriteFile(path, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	result := m.RemoveTasks([]int64{task.ID})
	if len(result.Failed) != 1 || !strings.Contains(result.Failed[0].Error, "cannot verify output owner") {
		t.Fatalf("inspection failure ignored: %+v", result)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "keep" {
		t.Fatalf("bytes lost: %q %v", data, err)
	}
}
