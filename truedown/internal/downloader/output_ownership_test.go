package downloader

import (
	"os"
	"path/filepath"
	"testing"
)

func TestHTTPOutputReservationsIncludeControlFiles(t *testing.T) {
	for _, batch := range []bool{false, true} {
		for _, names := range [][2]string{{"file.bin", "file.bin.aria2"}, {"file.bin.aria2", "file.bin"}} {
			mode := "single"
			if batch {
				mode = "batch"
			}
			t.Run(mode+"/"+names[0], func(t *testing.T) {
				m, _ := transferTestManager(t)
				requests := []taskAddRequest{
					{Link: "https://example.test/first", Name: names[0]},
					{Link: "https://example.test/second", Name: names[1]},
				}
				var tasks []*Task
				if batch {
					results, err := m.addTasksBatch(requests)
					if err != nil {
						t.Fatal(err)
					}
					for _, result := range results {
						tasks = append(tasks, result.Task)
					}
				} else {
					for _, request := range requests {
						task, _, err := m.AddTask(request.Link, request.Name, "", nil, "", 0, Aria2Opts{})
						if err != nil {
							t.Fatal(err)
						}
						tasks = append(tasks, task)
					}
				}
				if tasks[0].OutputName != names[0] || tasks[1].OutputName == names[1] {
					t.Fatalf("control-file collision was reserved: %q, %q", tasks[0].OutputName, tasks[1].OutputName)
				}
				owned := map[string]bool{}
				for _, task := range tasks {
					for _, suffix := range []string{"", ".aria2"} {
						path := filepath.Join(task.Folder, task.OutputName+suffix)
						if owned[path] || pathExists(path) {
							t.Fatalf("output pair was not uniquely reserved before admission: %s", path)
						}
						owned[path] = true
					}
				}
			})
		}
	}
}

func TestHTTPLegacyControlFileConflictsPreserveBothFiles(t *testing.T) {
	for _, names := range [][2]string{{"file.bin", "file.bin.aria2"}, {"file.bin.aria2", "file.bin"}} {
		for _, operation := range []string{"prepare", "cleanup"} {
			t.Run(operation+"/"+names[0], func(t *testing.T) {
				m, _ := transferTestManager(t)
				task := transferTestTask(t, m, names[0])
				// Older records could reserve a payload as another task's control file.
				m.mu.Lock()
				m.outputNames[outputNameKey(task.Folder, names[1])] = task.ID + 1
				m.mu.Unlock()
				for _, suffix := range []string{"", ".aria2"} {
					if err := os.WriteFile(filepath.Join(task.Folder, task.OutputName+suffix), []byte("owned data"), 0600); err != nil {
						t.Fatal(err)
					}
				}
				var err error
				m.opMu.Lock()
				if operation == "prepare" {
					_, err = m.prepareHTTPOutput(task.ID, false)
				} else {
					err = m.removeOwnedPartialFiles(task, "")
				}
				m.opMu.Unlock()
				if err == nil {
					t.Fatal("overlapping legacy ownership was accepted")
				}
				for _, suffix := range []string{"", ".aria2"} {
					data, err := os.ReadFile(filepath.Join(task.Folder, task.OutputName+suffix))
					if err != nil || string(data) != "owned data" {
						t.Fatalf("overlapping output changed: %q, %v", data, err)
					}
				}
			})
		}
	}
}

func TestHTTPOutputReservationsUnifyRelativeAndAbsoluteFolders(t *testing.T) {
	m, _ := transferTestManager(t)
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	relative, err := filepath.Rel(cwd, m.defaultDir)
	if err != nil {
		t.Fatal(err)
	}
	first, _, err := m.AddTask("https://example.test/first", "file.bin", "", nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := m.AddTask("https://example.test/second", "file.bin", relative, nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	if first.OutputName != "file.bin" || second.OutputName != "file(1).bin" {
		t.Fatalf("equivalent folders reserved the same output: %q, %q", first.OutputName, second.OutputName)
	}
	if firstKey, secondKey := outputNameKey(first.Folder, "file.bin"), outputNameKey(second.Folder, "file.bin"); firstKey != secondKey {
		t.Fatal("equivalent folders have different ownership identities")
	}
}
