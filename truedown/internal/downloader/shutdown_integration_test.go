package downloader

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"truedown/internal/enginesignal"
)

func TestEngineShutdownTiming(t *testing.T) {
	if os.Getenv("TRUEDOWN_INTEGRATION") == "" {
		t.Skip("set TRUEDOWN_INTEGRATION=1")
	}
	path, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"rpc", "interrupt"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			m, err := NewManagerWithConfig(path, filepath.Join(root, "downloads"), filepath.Join(root, "records.db"), shutdownTestConfig())
			if err != nil {
				t.Fatal(err)
			}
			defer m.Stop()
			if err := m.Start(); err != nil {
				t.Fatal(err)
			}
			start := time.Now()
			if mode == "rpc" {
				err = m.rpc.shutdown()
			} else {
				err = enginesignal.Interrupt(m.cmd.Process)
			}
			if err != nil {
				t.Fatal(err)
			}
			select {
			case <-m.cmdDone:
			case <-time.After(6 * time.Second):
				t.Fatal("engine did not stop")
			}
			t.Logf("%s shutdown: %s, exit=%v", mode, time.Since(start), m.cmd.ProcessState)
			if !m.cmd.ProcessState.Success() {
				t.Fatal("engine did not exit cleanly")
			}
			if mode == "interrupt" && !m.aria2Next && time.Since(start) > 2500*time.Millisecond {
				t.Fatal("normal interrupt retained the shutdown RPC delay")
			}
		})
	}
}

func shutdownTestConfig() ManagerConfig {
	version := os.Getenv("TRUEDOWN_ARIA2_NEXT_VERSION")
	return ManagerConfig{Aria2Next: version != "", Aria2NextVersion: version}
}

func TestManagerStopCheckpointsAndResumes(t *testing.T) {
	if os.Getenv("TRUEDOWN_INTEGRATION") == "" {
		t.Skip("set TRUEDOWN_INTEGRATION=1")
	}
	path, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	payload := bytes.Repeat([]byte("TrueDown checkpoint and resume\n"), 300000)
	var restarting, resumedRange atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if value := r.Header.Get("Range"); restarting.Load() && strings.HasPrefix(value, "bytes=") && !strings.HasPrefix(value, "bytes=0-") {
			resumedRange.Store(true)
		}
		http.ServeContent(w, r, "payload.bin", time.Unix(1000, 0), bytes.NewReader(payload))
	}))
	defer server.Close()
	root := t.TempDir()
	newManager := func() *Manager {
		t.Helper()
		m, err := NewManagerWithConfig(path, filepath.Join(root, "downloads"), filepath.Join(root, "records.db"), shutdownTestConfig())
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(m.Stop)
		return m
	}
	m := newManager()
	if _, err := m.SetRuntimeSettings(RuntimeSettings{ConcurrentDownloads: 1, GlobalDownloadLimitBps: 1024 * 1024}); err != nil {
		t.Fatal(err)
	}
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	task, _, err := m.AddTask(server.URL+"/payload.bin", "payload.bin", "", nil, "", 0, Aria2Opts{Connections: 1})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		task, _ = m.GetTask(task.ID)
		if task.CompletedLength >= 2*1024*1024 && task.Status == StatusDownloading {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("download did not reach checkpoint: %+v", task)
		}
		time.Sleep(50 * time.Millisecond)
	}
	start := time.Now()
	m.Stop()
	elapsed := time.Since(start)
	t.Logf("active download safe shutdown: %s, exit=%v", elapsed, m.cmd.ProcessState)
	if !m.aria2Next && elapsed > 2500*time.Millisecond {
		t.Fatal("safe shutdown retained the RPC delay")
	}
	if m.cmd.ProcessState == nil || (m.cmd.ProcessState.ExitCode() != 0 && m.cmd.ProcessState.ExitCode() != 7) {
		t.Fatal("engine was forcibly terminated")
	}
	output := filepath.Join(task.Folder, task.OutputName)
	if !m.aria2Next {
		if info, err := os.Stat(output + ".aria2"); err != nil || info.Size() == 0 {
			t.Fatalf("missing shutdown checkpoint: %v", err)
		}
	}
	restarting.Store(true)
	restarted := newManager()
	if _, err := restarted.SetRuntimeSettings(RuntimeSettings{ConcurrentDownloads: 1}); err != nil {
		t.Fatal(err)
	}
	if err := restarted.Start(); err != nil {
		t.Fatal(err)
	}
	waitForStatus(t, restarted, task.ID, 15*time.Second, StatusDone)
	if !resumedRange.Load() {
		t.Fatal("restarted download did not resume a saved range")
	}
	got, err := os.ReadFile(output)
	if err != nil || !bytes.Equal(got, payload) {
		t.Fatalf("resumed output mismatch: %v", err)
	}
}
