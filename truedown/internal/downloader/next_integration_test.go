package downloader

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestNext31FailedTasksStayFailedAfterRestart(t *testing.T) {
	config := integrationManagerConfig()
	if os.Getenv("TRUEDOWN_INTEGRATION") == "" || !aria2NextVersionAtLeast(config.Aria2NextVersion, 3, 1, 0) {
		t.Skip("requires NEXT 3.1+")
	}
	engine, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		http.Error(w, "missing", http.StatusNotFound)
	}))
	defer server.Close()
	root := t.TempDir()
	start := func() *Manager {
		m, err := NewManagerWithConfig(engine, filepath.Join(root, "downloads"), filepath.Join(root, "records.db"), config)
		if err != nil {
			t.Fatal(err)
		}
		if err := m.Start(); err != nil {
			m.Stop()
			t.Fatal(err)
		}
		return m
	}
	m := start()
	task, _, err := m.AddTask(server.URL+"/missing", "missing.bin", "", nil, "", 0, Aria2Opts{MaxTries: 1})
	if err != nil {
		m.Stop()
		t.Fatal(err)
	}
	waitForStatus(t, m, task.ID, 10*time.Second, StatusError)
	m.Stop()
	before := requests.Load()
	m = start()
	defer m.Stop()
	time.Sleep(1500 * time.Millisecond)
	restored, ok := m.GetTask(task.ID)
	if !ok || restored.Status != StatusError || requests.Load() != before {
		t.Fatalf("failed task retried on restart: task=%+v requests=%d want=%d", restored, requests.Load(), before)
	}
}

func TestNext31RedirectFilenameIntegration(t *testing.T) {
	config := integrationManagerConfig()
	if os.Getenv("TRUEDOWN_INTEGRATION") == "" || !aria2NextVersionAtLeast(config.Aria2NextVersion, 3, 1, 0) {
		t.Skip("requires NEXT 3.1+")
	}
	engine, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/download/3.28" {
			http.Redirect(w, r, "/setup.bin", http.StatusFound)
			return
		}
		http.ServeContent(w, r, "setup.bin", time.Unix(1000, 0), bytes.NewReader([]byte("redirected payload")))
	}))
	defer server.Close()
	root := t.TempDir()
	m, err := NewManagerWithConfig(engine, filepath.Join(root, "downloads"), filepath.Join(root, "records.db"), config)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	client := m.rpc.(*ariaClient)
	for index, hint := range []string{"", "chosen.bin"} {
		folder := filepath.Join(root, fmt.Sprintf("redirect-%d", index))
		options := map[string]any{"dir": folder, "allow-overwrite": "false", "auto-file-renaming": "false"}
		if hint != "" {
			options["out"] = hint
		}
		var gid string
		if err := client.call("aria2.addUri", []any{[]string{server.URL + "/download/3.28"}, options}, &gid); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(10 * time.Second)
		for {
			state, err := client.status(gid)
			if err != nil {
				t.Fatal(err)
			}
			if state.Status == "complete" {
				break
			}
			if state.Status == "error" || time.Now().After(deadline) {
				t.Fatalf("redirect did not complete: %+v", state)
			}
			time.Sleep(30 * time.Millisecond)
		}
		name := hint
		if name == "" {
			name = "setup.bin"
		}
		if data, err := os.ReadFile(filepath.Join(folder, name)); err != nil || string(data) != "redirected payload" {
			t.Fatalf("incorrect redirected output: %s %v", data, err)
		}
	}
}

func TestNext3NativePauseAndRemovalIntegration(t *testing.T) {
	config := integrationManagerConfig()
	if os.Getenv("TRUEDOWN_INTEGRATION") == "" || !aria2NextVersionAtLeast(config.Aria2NextVersion, 3, 0, 0) {
		t.Skip("requires NEXT 3")
	}
	engine, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	payload := bytes.Repeat([]byte("native pause and cleanup\n"), 400000)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeContent(w, r, "data.bin", time.Unix(1000, 0), bytes.NewReader(payload))
	}))
	defer server.Close()
	root := t.TempDir()
	m, err := NewManagerWithConfig(engine, filepath.Join(root, "downloads"), filepath.Join(root, "records.db"), config)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	task, _, err := m.AddTask(server.URL+"/data.bin", "data.bin", "", nil, "", 0, Aria2Opts{Connections: 1, MaxSpeedBps: 256 * 1024})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		current, _ := m.GetTask(task.ID)
		if current.CompletedLength >= 64*1024 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("transfer never made progress")
		}
		time.Sleep(30 * time.Millisecond)
	}
	if err := m.PauseTask(task.ID); err != nil {
		t.Fatal(err)
	}
	if state, err := m.rpc.status(task.GID); err != nil || state.Status != "paused" {
		t.Fatal("pause returned before the engine stopped", state, err)
	}
	// Test-only inspection proves the engine owns checkpoint creation/removal.
	// Production code never opens this database.
	db, err := openSQLite(filepath.Join(m.ariaStateDir, "stream", "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	checkpointCount := func() int64 {
		rows, err := db.Query(`SELECT COUNT(*) FROM downloads WHERE gid=?`, task.GID)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		if ok, err := rows.Next(); err != nil || !ok {
			t.Fatal("checkpoint query", err)
		}
		return rows.Int64(0)
	}
	if checkpointCount() != 1 {
		t.Fatal("pause lost native checkpoint")
	}
	if err := m.ResumeTask(task.ID); err != nil {
		t.Fatal(err)
	}
	waitForStatus(t, m, task.ID, 5*time.Second, StatusDownloading)
	if result := m.PauseQueue(); len(result.Failed) != 0 || len(result.Succeeded) != 1 {
		t.Fatalf("pause queue: %+v", result)
	}
	if state, err := m.rpc.status(task.GID); err != nil || state.Status != "paused" {
		t.Fatal("queue pause returned before the engine stopped", state, err)
	}
	if result := m.ResumeQueue(); len(result.Failed) != 0 || len(result.Succeeded) != 1 {
		t.Fatalf("immediate queue resume: %+v", result)
	}
	foreign := filepath.Join(task.Folder, "foreign.tmp")
	if err := os.WriteFile(foreign, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	result := m.RemoveTasks([]int64{task.ID})
	if len(result.Succeeded) != 1 || len(result.Failed) != 0 {
		t.Fatalf("remove: %+v", result)
	}
	if _, err := m.rpc.status(task.GID); !isGIDNotFound(err) {
		t.Fatal("native result remains", err)
	}
	if aria2NextVersionAtLeast(config.Aria2NextVersion, 3, 1, 1) {
		// NEXT prunes removed-transfer checkpoints at startup once it can
		// confirm the owned output was deleted on an available volume.
		m.Stop()
		restarted, err := NewManagerWithConfig(engine, filepath.Join(root, "downloads"), filepath.Join(root, "records.db"), config)
		if err != nil {
			t.Fatal(err)
		}
		defer restarted.Stop()
		if err := restarted.Start(); err != nil {
			t.Fatal(err)
		}
	}
	if checkpointCount() != 0 {
		t.Fatal("engine retained a removed download's checkpoint after cleanup")
	}
	if _, err := os.Stat(filepath.Join(task.Folder, task.OutputName)); !os.IsNotExist(err) {
		t.Fatal("owned incomplete output remains", err)
	}
	if data, err := os.ReadFile(foreign); err != nil || string(data) != "keep" {
		t.Fatal("removal touched foreign temporary file", err)
	}
}

func TestNextFilenameResolutionIntegration(t *testing.T) {
	config := integrationManagerConfig()
	if os.Getenv("TRUEDOWN_INTEGRATION") == "" || !aria2NextVersionAtLeast(config.Aria2NextVersion, 2, 8, 3) {
		t.Skip("requires NEXT 2.8.3+ integration engine")
	}
	engine, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	m, err := NewManagerWithConfig(engine, filepath.Join(root, "downloads"), filepath.Join(root, "records.db"), config)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	client := m.rpc.(*ariaClient)
	if !client.filenameResolution.Load() {
		t.Fatal("release lacks filename-resolution capability")
	}
	for _, test := range []struct{ url, header, want string }{
		{"https://example.invalid/a%20b.zip", "", "a b.zip"},
		{"https://example.invalid/fallback.bin", "attachment; filename*=UTF-8''caf%C3%A9.zip", "caf\u00e9.zip"},
		{"https://example.invalid/a%2520b.zip", "", "a%20b.zip"},
	} {
		got, err := client.resolveFilename(context.Background(), test.url, test.header)
		if err != nil || got != test.want {
			t.Fatalf("resolve filename=%q want=%q err=%v", got, test.want, err)
		}
	}
	if states, err := client.statuses(); err != nil || len(states) != 0 {
		t.Fatalf("filename preview created tasks: %v %v", states, err)
	}
}

func TestNext3CheckpointOptionsIntegration(t *testing.T) {
	config := integrationManagerConfig()
	if os.Getenv("TRUEDOWN_INTEGRATION") == "" || !aria2NextVersionAtLeast(config.Aria2NextVersion, 3, 0, 0) {
		t.Skip("requires NEXT 3 integration engine")
	}
	engine, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	m, err := NewManagerWithConfig(engine, filepath.Join(root, "downloads"), filepath.Join(root, "records.db"), config)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	args := strings.Join(m.aria2StartArgs(15152, "test", m.RuntimeSettings()), "\n")
	if strings.Contains(args, "--bt-resume-save-interval=") || strings.Contains(args, "--auto-save-interval=") {
		t.Fatalf("retired checkpoint options: %s", args)
	}
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	requireAriaGlobalOption(t, m, "state-save-interval", "1")
}

func TestNextBTIdentityIntegration(t *testing.T) {
	config := integrationManagerConfig()
	if os.Getenv("TRUEDOWN_INTEGRATION") == "" || !aria2NextVersionAtLeast(config.Aria2NextVersion, 2, 6, 7) {
		t.Skip("requires NEXT 2.6.7+ integration engine")
	}
	engine, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	database := filepath.Join(root, "records.db")
	folder := filepath.Join(root, "downloads")
	m, err := NewManagerWithConfig(engine, folder, database, config)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	ua, prefix := "TrueDown-test/1.0", "-TD1000-"
	if _, err := m.UpdateRuntimeSettings(RuntimeSettingsUpdate{BTUserAgent: &ua, BTPeerIDPrefix: &prefix}); err != nil {
		t.Fatal(err)
	}
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	requireAriaGlobalOption(t, m, "bt-user-agent", ua)
	requireAriaGlobalOption(t, m, "bt-peer-id-prefix", prefix)
	ua, prefix = "TrueDown-test/2.0", "-TD2000-"
	if _, err := m.UpdateRuntimeSettings(RuntimeSettingsUpdate{BTUserAgent: &ua, BTPeerIDPrefix: &prefix}); err != nil {
		t.Fatal(err)
	}
	requireAriaGlobalOption(t, m, "bt-user-agent", ua)
	requireAriaGlobalOption(t, m, "bt-peer-id-prefix", prefix)
	m.Stop()
	restored, err := NewManagerWithConfig(engine, folder, database, config)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Stop()
	if err := restored.Start(); err != nil {
		t.Fatal(err)
	}
	requireAriaGlobalOption(t, restored, "bt-user-agent", ua)
	requireAriaGlobalOption(t, restored, "bt-peer-id-prefix", prefix)
	blank := ""
	if _, err := restored.UpdateRuntimeSettings(RuntimeSettingsUpdate{BTUserAgent: &blank, BTPeerIDPrefix: &blank}); err != nil {
		t.Fatal(err)
	}
	requireAriaGlobalOption(t, restored, "bt-user-agent", defaultBTUserAgent)
	requireAriaGlobalOption(t, restored, "bt-peer-id-prefix", defaultBTPeerIDPrefix)
}
