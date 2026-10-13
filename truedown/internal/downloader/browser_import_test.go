package downloader

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

type blockedBrowserResolver struct {
	resolverModule
	entered chan struct{}
	release chan struct{}
}

func (r *blockedBrowserResolver) matches(link string) bool {
	return link == "https://example.test/slow"
}
func (r *blockedBrowserResolver) resolve(ctx context.Context, m *Manager, request moduleResolveRequest) (ModuleAddResult, bool, error) {
	select {
	case r.entered <- struct{}{}:
	default:
	}
	select {
	case <-ctx.Done():
		return ModuleAddResult{}, true, ctx.Err()
	case <-r.release:
	}
	task, duplicate, err := m.AddTask("https://example.test/resolved.bin", request.Name, "", request.Headers, request.DownloadPage, 0, request.Opts)
	result := ModuleAddResult{Tasks: []*Task{task}}
	if duplicate {
		result.Duplicates = 1
	}
	return result, true, err
}

func installBlockedBrowserResolver(m *Manager) *blockedBrowserResolver {
	m.modules.mu.Lock()
	defer m.modules.mu.Unlock()
	component := m.modules.active[DropboxModuleID]
	r := &blockedBrowserResolver{resolverModule: component.module, entered: make(chan struct{}, 1), release: make(chan struct{})}
	component.module = r
	m.modules.active[DropboxModuleID] = component
	m.modules.installed[DropboxModuleID] = true
	return r
}

func awaitBrowserImport(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("browser import did not settle")
}

func TestBrowserImportDurableAcknowledgementAndRestart(t *testing.T) {
	root := t.TempDir()
	open := func() *Manager {
		m, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(m.Stop)
		return m
	}
	m := open()
	r := installBlockedBrowserResolver(m)
	ctx, cancel := context.WithCancel(context.Background())
	items := []BrowserImportItem{{Link: "https://example.test/first", Name: "first.bin"}, {Link: "https://example.test/slow", Name: "second.bin", Headers: map[string]string{"Cookie": "private=value"}}}
	started := time.Now()
	if err := m.AcceptBrowserImport(ctx, items, true); err != nil {
		t.Fatal(err)
	}
	if time.Since(started) >= 500*time.Millisecond {
		t.Fatal("acknowledgement exceeded browser timeout")
	}
	cancel() // The browser request ends immediately after receiving OK.
	select {
	case <-r.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("resolver did not start")
	}
	entry, err := m.store.nextBrowserImport()
	if err != nil || entry == nil || entry.next != 1 {
		t.Fatalf("durable cursor=%+v err=%v", entry, err)
	}
	first := m.ListTasks()[0]
	if first.Status != StatusPaused {
		t.Fatal("silent import started a task")
	}
	if err := m.AcceptBrowserImport(context.Background(), items, true); err != nil {
		t.Fatal(err)
	}
	m.Stop() // Cancels the resolver and keeps the accepted remainder.
	if err := m.AcceptBrowserImport(context.Background(), items, true); !errors.Is(err, ErrBrowserImportBusy) {
		t.Fatalf("accepted after shutdown: %v", err)
	}

	restarted := open()
	replay := installBlockedBrowserResolver(restarted)
	close(replay.release)
	restarted.wakeBrowserImports()
	awaitBrowserImport(t, func() bool { entry, err := restarted.store.nextBrowserImport(); return err == nil && entry == nil })
	tasks := restarted.ListTasks()
	if len(tasks) != 2 {
		t.Fatalf("lost or duplicated accepted items: %+v", tasks)
	}
	for _, task := range tasks {
		if task.Status != StatusPaused {
			t.Fatal("restart lost initial pause")
		}
		if task.Name == "first.bin" && task.ID != first.ID {
			t.Fatal("replayed completed cursor")
		}
		if task.Name == "second.bin" && task.Headers["Cookie"] != "private=value" {
			t.Fatal("lost private request headers")
		}
	}
}

func TestBrowserImportCommitLimitsAndValidation(t *testing.T) {
	root := t.TempDir()
	m, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	if err := m.AcceptBrowserImport(context.Background(), []BrowserImportItem{{Link: "https://example.test/ok"}, {Link: "file:///invalid"}}, false); err == nil {
		t.Fatal("accepted invalid batch")
	}
	if entry, _ := m.store.nextBrowserImport(); entry != nil {
		t.Fatal("partially persisted invalid batch")
	}
	for i := 0; i < maxPendingBrowserImports; i++ {
		data, _ := json.Marshal(browserImportRequest{Items: []BrowserImportItem{{Link: fmt.Sprintf("https://example.test/%d", i)}}})
		if err := m.store.enqueueBrowserImport(data); err != nil {
			t.Fatal(err)
		}
		if err := m.store.enqueueBrowserImport(data); err != nil {
			t.Fatal("duplicate consumes capacity", err)
		}
	}
	if err := m.AcceptBrowserImport(context.Background(), []BrowserImportItem{{Link: "https://example.test/overflow"}}, false); !errors.Is(err, ErrBrowserImportBusy) {
		t.Fatalf("unbounded queue: %v", err)
	}
	if err := m.store.Close(); err != nil {
		t.Fatal(err)
	}
	if err := m.AcceptBrowserImport(context.Background(), []BrowserImportItem{{Link: "https://example.test/no-database"}}, false); err == nil {
		t.Fatal("acknowledged without durable storage")
	}
}

func TestBrowserImportReplayPreservesCompletedTask(t *testing.T) {
	root := t.TempDir()
	m, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	task, _, err := m.AddTask("https://example.test/file", "file.bin", "", nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	m.flushAdmissions(false)
	if err := m.setTask(task.ID, func(task *Task) { task.Status = StatusDone }); err != nil {
		t.Fatal(err)
	}
	if err := m.AcceptBrowserImport(context.Background(), []BrowserImportItem{{Link: task.Link, Name: task.Name}}, false); err != nil {
		t.Fatal(err)
	}
	awaitBrowserImport(t, func() bool { entry, err := m.store.nextBrowserImport(); return err == nil && entry == nil })
	after, _ := m.GetTask(task.ID)
	if after.Status != StatusDone || after.GID != task.GID || len(m.ListTasks()) != 1 {
		t.Fatal("replay restarted completed task")
	}
	if ok, err := m.store.browserImportTasksPersisted([]*Task{after, after}); err != nil || !ok {
		t.Fatal("duplicate output IDs never settle", err)
	}
}
