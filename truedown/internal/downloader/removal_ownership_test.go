package downloader

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRemoveHTTPTaskRejectsOverlappingOutputOwnership(t *testing.T) {
	for _, names := range [][2]string{{"file.bin", "file.bin"}, {"file.bin", "file.bin.aria2"}, {"file.bin.aria2", "file.bin"}} {
		t.Run(names[0]+"/"+names[1], func(t *testing.T) {
			m, _ := transferTestManager(t)
			task := transferTestTask(t, m, names[0])
			// Simulate overlapping records created before pair reservations existed.
			m.mu.Lock()
			m.reserveOutputLocked(task.Folder, names[1], task.ID+1)
			m.mu.Unlock()
			for _, suffix := range []string{"", ".aria2"} {
				if err := os.WriteFile(filepath.Join(task.Folder, task.OutputName+suffix), []byte("preserve"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			result := m.RemoveTasks([]int64{task.ID})
			if len(result.Succeeded) != 0 || len(result.Failed) != 1 {
				t.Fatalf("conflicting removal succeeded: %+v", result)
			}
			if result.Failed[0].ID != task.ID || !strings.Contains(result.Failed[0].Error, "belongs to task") {
				t.Fatalf("missing ownership diagnosis: %+v", result)
			}
			if _, exists := m.GetTask(task.ID); !exists {
				t.Fatal("failed cleanup lost its task record")
			}
			for _, suffix := range []string{"", ".aria2"} {
				data, err := os.ReadFile(filepath.Join(task.Folder, task.OutputName+suffix))
				if err != nil || string(data) != "preserve" {
					t.Fatalf("conflicting output was changed: %q, %v", data, err)
				}
			}
		})
	}
}

func TestRemoveBitTorrentTaskPreservesNativePayload(t *testing.T) {
	for _, multi := range []bool{false, true} {
		t.Run(map[bool]string{false: "single-file", true: "multi-file"}[multi], func(t *testing.T) {
			m, rpc := transferTestManager(t)
			m.aria2Next = true
			task, _, err := m.AddBitTorrentLink("https://example.test/archive.torrent", "", nil, "", Aria2Opts{})
			if err != nil {
				t.Fatal(err)
			}
			m.flushAdmissions(false)
			if err := m.setTask(task.ID, func(task *Task) { task.OutputName = "payload" }); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(task.Folder, "payload")
			rpc.statusPath = path
			if multi {
				path = filepath.Join(path, "member.bin")
				rpc.statusPath = path
			}
			if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte("torrent bytes"), 0600); err != nil {
				t.Fatal(err)
			}
			result := m.RemoveTasks([]int64{task.ID})
			if len(result.Succeeded) != 1 || len(result.Failed) != 0 {
				t.Fatalf("torrent record removal failed: %+v", result)
			}
			if len(rpc.removed) != 1 || rpc.removed[0] != task.GID {
				t.Fatal("torrent writer was not stopped")
			}
			if data, err := os.ReadFile(path); err != nil || string(data) != "torrent bytes" {
				t.Fatalf("native torrent payload changed: %q, %v", data, err)
			}
			if _, exists := m.GetTask(task.ID); exists {
				t.Fatal("removed torrent record remains")
			}
		})
	}
}

func TestRemoveTaskRejectsInvalidStoredIdentity(t *testing.T) {
	m, _ := transferTestManager(t)
	task := transferTestTask(t, m, "file.bin")
	if err := m.setTask(task.ID, func(task *Task) { task.RequestJSON = "{" }); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(task.Folder, task.OutputName)
	if err := os.WriteFile(path, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	result := m.RemoveTasks([]int64{task.ID})
	if len(result.Succeeded) != 0 || len(result.Failed) != 1 || !strings.Contains(result.Failed[0].Error, "invalid task identity") {
		t.Fatalf("invalid identity was not rejected: %+v", result)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "preserve" {
		t.Fatalf("unidentified output changed: %q, %v", data, err)
	}
	if _, exists := m.GetTask(task.ID); !exists {
		t.Fatal("failed cleanup lost its task record")
	}
}
