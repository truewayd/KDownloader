package downloader

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestManagerAria2Lifecycle(t *testing.T) {
	if os.Getenv("TRUEDOWN_INTEGRATION") == "" {
		t.Skip("set TRUEDOWN_INTEGRATION=1 to run the aria2 integration test")
	}
	aria2Path, err := filepath.Abs(filepath.Join("..", "..", "aria2", "aria2c.exe"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(aria2Path); err != nil {
		t.Skipf("aria2 executable unavailable: %v", err)
	}

	sourceDir := t.TempDir()
	payload := []byte(strings.Repeat("TrueDown integration payload\n", 16384))
	if err := os.WriteFile(filepath.Join(sourceDir, "payload.bin"), payload, 0644); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.FileServer(http.Dir(sourceDir)))
	defer server.Close()

	stateDir := t.TempDir()
	m, err := NewManager(aria2Path, filepath.Join(stateDir, "downloads"), filepath.Join(stateDir, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.SetRuntimeSettings(RuntimeSettings{
		ConcurrentDownloads:    2,
		GlobalDownloadLimitBps: 32 * 1024,
	}); err != nil {
		t.Fatalf("persist aria2 global settings before startup: %v", err)
	}
	if err := m.Start(); err != nil {
		m.Stop()
		t.Fatal(err)
	}
	defer m.Stop()
	requireAriaGlobalOption(t, m, "max-concurrent-downloads", "2")
	requireAriaGlobalOption(t, m, "max-overall-download-limit", "32768")
	if _, err := m.SetRuntimeSettings(RuntimeSettings{
		ConcurrentDownloads:    2,
		GlobalDownloadLimitBps: 64 * 1024,
	}); err != nil {
		t.Fatalf("apply aria2 global settings: %v", err)
	}
	requireAriaGlobalOption(t, m, "max-overall-download-limit", "65536")

	link := server.URL + "/payload.bin"
	task, duplicate, err := m.AddTask(link, "payload.bin", "", nil, "", 0, Aria2Opts{MaxSpeedBps: 32768})
	if err != nil || duplicate {
		t.Fatalf("first AddTask: task=%v duplicate=%v err=%v", task, duplicate, err)
	}
	same, duplicate, err := m.AddTask(link, "payload.bin", "", map[string]string{}, "", 0, Aria2Opts{MaxSpeedBps: 32768})
	if err != nil || !duplicate || same.ID != task.ID {
		t.Fatalf("duplicate AddTask: task=%v duplicate=%v err=%v", same, duplicate, err)
	}

	waitForStatus(t, m, task.ID, 8*time.Second, StatusDownloading)
	if err := m.PauseTask(task.ID); err != nil {
		t.Fatal(err)
	}
	waitForStatus(t, m, task.ID, 4*time.Second, StatusPaused)
	if err := m.ResumeTask(task.ID); err != nil {
		t.Fatal(err)
	}
	waitForStatus(t, m, task.ID, 20*time.Second, StatusDone)

	same, duplicate, err = m.AddTask(link, "payload.bin", "", nil, "", 0, Aria2Opts{MaxSpeedBps: 32768})
	if err != nil || !duplicate || same.ID != task.ID {
		t.Fatalf("completed duplicate AddTask: task=%v duplicate=%v err=%v", same, duplicate, err)
	}
	waitForStatus(t, m, task.ID, 8*time.Second, StatusDone)
	if count := m.ClearDone(); count != 1 {
		t.Fatalf("ClearDone()=%d, want 1", count)
	}
	if tasks := m.ListTasks(); len(tasks) != 0 {
		t.Fatalf("tasks remained after ClearDone: %v", tasks)
	}

	partial, duplicate, err := m.AddTask(link, "partial.bin", "", nil, "", 0, Aria2Opts{MaxSpeedBps: 16384})
	if err != nil || duplicate {
		t.Fatalf("partial AddTask: task=%v duplicate=%v err=%v", partial, duplicate, err)
	}
	waitForStatus(t, m, partial.ID, 8*time.Second, StatusDownloading)
	partialPath := filepath.Join(stateDir, "downloads", partial.OutputName)
	if result := m.RemoveTasks([]int64{partial.ID}); len(result.Succeeded) != 1 || len(result.Failed) != 0 {
		t.Fatalf("RemoveTasks: %+v", result)
	}
	for _, path := range []string{partialPath, partialPath + ".aria2"} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("removed partial file %q remains: %v", path, err)
		}
	}
}

func TestManagerDetectsUnexpectedAria2ExitForRecovery(t *testing.T) {
	if os.Getenv("TRUEDOWN_INTEGRATION") == "" {
		t.Skip("set TRUEDOWN_INTEGRATION=1 to run the aria2 integration test")
	}
	aria2Path, err := filepath.Abs(filepath.Join("..", "..", "aria2", "aria2c.exe"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(aria2Path); err != nil {
		t.Skipf("aria2 executable unavailable: %v", err)
	}

	sourceDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(sourceDir, "payload.bin"), []byte(strings.Repeat("recovery\n", 128*1024)), 0600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.FileServer(http.Dir(sourceDir)))
	defer server.Close()
	exits := make(chan error, 1)
	stateDir := t.TempDir()
	manager, err := NewManagerWithConfig(
		aria2Path,
		filepath.Join(stateDir, "downloads"),
		filepath.Join(stateDir, "records.db"),
		ManagerConfig{EngineExit: func(_ *Manager, exitErr error) { exits <- exitErr }},
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.Start(); err != nil {
		manager.Stop()
		t.Fatal(err)
	}
	defer manager.Stop()
	task, _, err := manager.AddTask(server.URL+"/payload.bin", "payload.bin", "", nil, "", 0, Aria2Opts{MaxSpeedBps: 16 * 1024})
	if err != nil {
		t.Fatal(err)
	}
	waitForStatus(t, manager, task.ID, 8*time.Second, StatusDownloading)
	if manager.cmd == nil || manager.cmd.Process == nil {
		t.Fatal("managed aria2 process is unavailable")
	}
	if err := manager.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-exits:
	case <-time.After(10 * time.Second):
		t.Fatal("manager did not report the terminated aria2 process")
	}
	waitForStatus(t, manager, task.ID, 5*time.Second, StatusQueued)
	recovering, _ := manager.GetTask(task.ID)
	if recovering.Error != "" || !strings.Contains(recovering.Progress, "recovering") {
		t.Fatalf("task after unexpected engine exit=%+v", recovering)
	}
}

func requireAriaGlobalOption(t *testing.T, m *Manager, name, want string) {
	t.Helper()
	client, ok := m.rpc.(*ariaClient)
	if !ok {
		t.Fatalf("aria2 client has type %T", m.rpc)
	}
	var options map[string]string
	if err := client.call("aria2.getGlobalOption", nil, &options); err != nil {
		t.Fatalf("read aria2 global options: %v", err)
	}
	if got := options[name]; got != want {
		t.Fatalf("aria2 global option %s=%q, want %q", name, got, want)
	}
}

func waitForStatus(t *testing.T, m *Manager, id int64, timeout time.Duration, want Status) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var last *Task
	for time.Now().Before(deadline) {
		last, _ = m.GetTask(id)
		if last != nil && last.Status == want {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("task %d did not reach %s; last=%+v", id, want, last)
}
