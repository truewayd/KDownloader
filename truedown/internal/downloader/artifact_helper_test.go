package downloader

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"truedown/internal/modulehost"
)

func artifactTempDir(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func TestArtifactStaleCompletionCannotStartWriter(t *testing.T) {
	for _, obsoleteAttempt := range []bool{false, true} {
		root := artifactTempDir(t)
		manager, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
		if err != nil {
			t.Fatal(err)
		}
		manager.rpc = &fakeAriaRPC{}
		task, _, err := manager.AddTask("https://example.test/file.bin", "file.bin", "", nil, "", 0, Aria2Opts{})
		if err != nil {
			manager.Stop()
			t.Fatal(err)
		}
		manager.flushAdmissions(false)
		current, _ := manager.GetTask(task.ID)
		job := &artifactJob{task: current, phase: "transport"}
		manager.artifacts.jobs[current.GID] = job
		pollRevision := current.Revision - 1
		if obsoleteAttempt {
			manager.mu.Lock()
			manager.tasks[current.ID].PreviousGID = current.GID
			manager.mu.Unlock()
			pollRevision = manager.revision
		}
		manager.applyStatusesAtRevision([]ariaStatus{{GID: current.GID, Status: "complete"}}, pollRevision)
		manager.artifacts.mu.Lock()
		started := job.phase != "transport" || job.done != nil
		manager.artifacts.mu.Unlock()
		manager.Stop()
		if started {
			t.Fatal("stale completion started a module writer")
		}
	}
}

func runArtifactTestHelper() {
	for {
		var request modulehost.Request
		if modulehost.ReadFrame(os.Stdin, &request) != nil {
			return
		}
		var value any
		code := ""
		switch request.Method {
		case "hello":
			value = modulehost.Hello{Protocol: 1, ModuleID: "mega", Version: "0.1.0", Capabilities: []string{"aria2-artifact-v1"}}
			if version := os.Getenv("TRUEDOWN_TEST_MODULE_VERSION"); version != "" {
				value = modulehost.Hello{Protocol: 1, ModuleID: "mega", Version: version, Capabilities: []string{"aria2-artifact-v1"}}
			}
		case "prepare":
			value = modulehost.PreparedArtifact{Name: "fixture.bin", Size: 2 * 1024 * 1024, URL: os.Getenv("TRUEDOWN_TEST_ARTIFACT_URL")}
		case "transform":
			if os.Getenv("TRUEDOWN_TEST_ARTIFACT_DELAY") == "1" {
				time.Sleep(time.Minute)
			}
			data, err := os.ReadFile("ciphertext")
			if err != nil {
				return
			}
			for i := range data {
				data[i] ^= 0xaa
			}
			hash := sha256.Sum256(data)
			if hex.EncodeToString(hash[:]) != os.Getenv("TRUEDOWN_TEST_ARTIFACT_SHA256") {
				code = "integrity"
				break
			}
			file, err := os.OpenFile("payload", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
			if err != nil {
				return
			}
			file.Write(data)
			file.Sync()
			file.Close()
			value = modulehost.VerifiedArtifact{Size: int64(len(data)), SHA256: hex.EncodeToString(hash[:])}
		case "shutdown":
			return
		default:
			code = "unsupported"
		}
		body, _ := json.Marshal(value)
		if modulehost.WriteFrame(os.Stdout, modulehost.Response{ID: request.ID, Session: request.Session, Body: body, Error: code}) != nil {
			return
		}
	}
}

func artifactHelper(t *testing.T) (string, []byte) {
	t.Helper()
	root := artifactTempDir(t)
	directory := filepath.Join(root, "mega")
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	entry := "truedown-mega"
	if runtime.GOOS == "windows" {
		entry += ".exe"
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	source, err := os.Open(self)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	output, err := os.OpenFile(filepath.Join(directory, entry), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.Copy(output, source)
	output.Close()
	if err != nil {
		t.Fatal(err)
	}
	data := make([]byte, 2*1024*1024)
	for i := range data {
		data[i] = byte(i*17 + i/255)
	}
	hash := sha256.Sum256(data)
	t.Setenv("TRUEDOWN_TEST_ARTIFACT_HELPER", "1")
	t.Setenv("TRUEDOWN_TEST_ARTIFACT_SHA256", hex.EncodeToString(hash[:]))
	return root, data
}

func TestArtifactPublicationAndRecovery(t *testing.T) {
	root, data := artifactHelper(t)
	entry := "truedown-mega"
	if runtime.GOOS == "windows" {
		entry += ".exe"
	}
	executable := filepath.Join(root, "mega", entry)
	folder := artifactTempDir(t)
	task := &Task{ID: 1, GID: "one", ModuleID: "mega", Link: "fixture", Folder: folder, OutputName: "result.bin", TotalLength: int64(len(data))}
	a := newArtifactTransfers(context.Background())
	defer a.close()
	transport, err := a.prepare(task, artifactPlan{Executable: executable, Source: "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	encrypted := append([]byte(nil), data...)
	for i := range encrypted {
		encrypted[i] ^= 0xaa
	}
	if err := os.WriteFile(filepath.Join(transport.Folder, "ciphertext"), encrypted, 0600); err != nil {
		t.Fatal(err)
	}
	state := []ariaStatus{{GID: task.GID, Status: "complete"}}
	if got := a.filter(state)[0].Status; got == "complete" {
		t.Fatal("ciphertext completion leaked")
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		state[0].Status = "complete"
		got := a.filter(state)[0].Status
		if got == "error" {
			t.Fatal("verification failed")
		}
		if got == "complete" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	want := sha256.Sum256(data)
	actual, err := artifactHash(filepath.Join(folder, "result.bin"), int64(len(data)))
	if err != nil || actual != hex.EncodeToString(want[:]) {
		t.Fatalf("publication: %v", err)
	}
	a.close()
	b := newArtifactTransfers(context.Background())
	defer b.close()
	if _, err := b.prepare(task, artifactPlan{Executable: "must-not-run", Source: "fixture"}); err != nil {
		t.Fatal(err)
	}
	state[0].Status = "complete"
	b.filter(state)
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		state[0].Status = "complete"
		if b.filter(state)[0].Status == "complete" {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("published journal did not recover")
}

func TestArtifactPauseIntegrityAndOutputCollision(t *testing.T) {
	for _, scenario := range []string{"pause", "corrupt", "collision"} {
		t.Run(scenario, func(t *testing.T) {
			root, data := artifactHelper(t)
			entry := "truedown-mega"
			if runtime.GOOS == "windows" {
				entry += ".exe"
			}
			task := &Task{ID: 7, GID: "fixture", ModuleID: "mega", Link: "fixture", Folder: artifactTempDir(t), OutputName: "result.bin", TotalLength: int64(len(data))}
			a := newArtifactTransfers(context.Background())
			defer a.close()
			transport, err := a.prepare(task, artifactPlan{Executable: filepath.Join(root, "mega", entry)})
			if err != nil {
				t.Fatal(err)
			}
			encrypted := append([]byte(nil), data...)
			for i := range encrypted {
				encrypted[i] ^= 0xaa
			}
			if scenario == "corrupt" {
				encrypted[0] ^= 1
			}
			if err := os.WriteFile(filepath.Join(transport.Folder, "ciphertext"), encrypted, 0600); err != nil {
				t.Fatal(err)
			}
			final := filepath.Join(task.Folder, task.OutputName)
			if scenario == "collision" {
				if err := os.WriteFile(final, []byte("foreign"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "pause" {
				t.Setenv("TRUEDOWN_TEST_ARTIFACT_DELAY", "1")
			}
			states := []ariaStatus{{GID: task.GID, Status: "complete"}}
			a.filter(states)
			if scenario == "pause" {
				if handled, err := a.control(task.GID, true); !handled || err != nil {
					t.Fatalf("pause: %v", err)
				}
				if _, err := os.Stat(final); !os.IsNotExist(err) {
					t.Fatal("paused transform published output")
				}
				t.Setenv("TRUEDOWN_TEST_ARTIFACT_DELAY", "")
				if handled, err := a.control(task.GID, false); !handled || err != nil {
					t.Fatalf("resume: %v", err)
				}
			}
			deadline := time.Now().Add(8 * time.Second)
			for time.Now().Before(deadline) {
				states[0].Status = "complete"
				state := a.filter(states)[0]
				if state.Status == "complete" || state.Status == "error" {
					if scenario == "pause" && state.Status != "complete" {
						t.Fatal("resumed transform failed")
					}
					if scenario != "pause" && state.Status != "error" {
						t.Fatal("unsafe artifact published")
					}
					if scenario == "collision" {
						actual, _ := os.ReadFile(final)
						if string(actual) != "foreign" {
							t.Fatal("foreign output overwritten")
						}
					}
					if scenario == "corrupt" {
						if _, err := os.Stat(final); !os.IsNotExist(err) {
							t.Fatal("corrupt plaintext published")
						}
					}
					return
				}
				time.Sleep(10 * time.Millisecond)
			}
			t.Fatal("transform completion deadline")
		})
	}
}
