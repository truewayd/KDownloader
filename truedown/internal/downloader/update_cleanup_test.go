package downloader

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestUpdateCleanupVerifiesPayloadAndOwnsTaskRemoval(t *testing.T) {
	for _, scenario := range []string{"success", "record-removed", "payload-missing", "checksum", "active", "overlap", "foreign-file", "control-directory"} {
		t.Run(scenario, func(t *testing.T) {
			base := t.TempDir()
			root := filepath.Join(base, "updates")
			folder := filepath.Join(root, "download-fixture")
			if err := os.MkdirAll(folder, 0700); err != nil {
				t.Fatal(err)
			}
			m, err := NewManager("unused", filepath.Join(base, "downloads"), filepath.Join(base, "records.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer m.Stop()
			name := "TrueDown-build-42.zip"
			task, _, err := m.addTaskWithModule("https://example.test/update", name, folder, nil, "", 0, Aria2Opts{}, "")
			if err != nil {
				t.Fatal(err)
			}
			folder = task.Folder
			if err := os.MkdirAll(folder, 0700); err != nil {
				t.Fatal(err)
			}
			if err := m.setTask(task.ID, func(current *Task) { current.Status = StatusDone; current.OutputName = name }); err != nil {
				t.Fatal(err)
			}
			payload := []byte("verified update bytes")
			digest := fmt.Sprintf("%x", sha256.Sum256(payload))
			output := filepath.Join(folder, name)
			if err := os.WriteFile(output, payload, 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(output+".aria2", []byte("control"), 0600); err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "record-removed":
				if !m.DeleteTask(task.ID) {
					t.Fatal("remove record")
				}
			case "payload-missing":
				if err := os.Remove(output); err != nil {
					t.Fatal(err)
				}
			case "checksum":
				if err := os.WriteFile(output, []byte("modified update bytes"), 0600); err != nil {
					t.Fatal(err)
				}
			case "active":
				if err := m.setTask(task.ID, func(current *Task) { current.Status = StatusPaused }); err != nil {
					t.Fatal(err)
				}
			case "overlap":
				// Model a legacy record overlapping the payload's control file.
				m.mu.Lock()
				m.outputNames[outputNameKey(folder, name+".aria2")] = task.ID + 1
				m.mu.Unlock()
			case "foreign-file":
				if err := os.WriteFile(filepath.Join(folder, "keep.txt"), []byte("user file"), 0600); err != nil {
					t.Fatal(err)
				}
			case "control-directory":
				if err := os.Remove(output + ".aria2"); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(output+".aria2", 0700); err != nil {
					t.Fatal(err)
				}
			}
			err = m.CleanupUpdateDownloads(root, name, digest, int64(len(payload)))
			blocked := scenario == "checksum" || scenario == "active" || scenario == "overlap" || scenario == "control-directory"
			if blocked {
				if err == nil {
					t.Fatal("unsafe cleanup succeeded")
				}
				if _, err := os.Lstat(output); err != nil {
					t.Fatal("payload removed", err)
				}
				if _, exists := m.GetTask(task.ID); !exists {
					t.Fatal("task removed")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := os.Lstat(output); !os.IsNotExist(err) {
				t.Fatal("payload remains", err)
			}
			if _, err := os.Lstat(output + ".aria2"); !os.IsNotExist(err) {
				t.Fatal("control remains", err)
			}
			if _, exists := m.GetTask(task.ID); exists {
				t.Fatal("completed task remains")
			}
			if scenario == "foreign-file" {
				if _, err := os.Stat(filepath.Join(folder, "keep.txt")); err != nil {
					t.Fatal("unrelated file removed", err)
				}
			} else if _, err := os.Stat(folder); !os.IsNotExist(err) {
				t.Fatal("empty directory remains", err)
			}
			if err := m.CleanupUpdateDownloads(root, name, digest, int64(len(payload))); err != nil {
				t.Fatal("cleanup is not idempotent", err)
			}
		})
	}
}

func TestUpdateCleanupDoesNotFollowDirectoryLinks(t *testing.T) {
	base := t.TempDir()
	root, outside := filepath.Join(base, "updates"), filepath.Join(base, "outside")
	for _, directory := range []string{root, outside} {
		if err := os.MkdirAll(directory, 0700); err != nil {
			t.Fatal(err)
		}
	}
	data := []byte("retained")
	name := "update.zip"
	if err := os.WriteFile(filepath.Join(outside, name), data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "download-link")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	m, err := NewManager("unused", filepath.Join(base, "downloads"), filepath.Join(base, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	if err := m.CleanupUpdateDownloads(root, name, fmt.Sprintf("%x", sha256.Sum256(data)), int64(len(data))); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(outside, name)); err != nil {
		t.Fatal("external file removed", err)
	}
}
