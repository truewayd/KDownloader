package downloader

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestTaskDefaultsPersistConflictAndFailedWrite(t *testing.T) {
	root := t.TempDir()
	s, err := newTaskDefaultsStore(filepath.Join(root, "tasks.db"))
	if err != nil {
		t.Fatal(err)
	}
	m := &Manager{taskDefaults: s}
	values := m.TaskDefaults().Values
	values.Connections = 8
	saved, err := m.SetTaskDefaults(0, values)
	if err != nil || saved.Revision != 1 {
		t.Fatalf("%+v %v", saved, err)
	}
	reloaded, err := newTaskDefaultsStore(filepath.Join(root, "tasks.db"))
	if err != nil || reloaded.state != saved {
		t.Fatalf("reload %+v %v", reloaded, err)
	}
	if _, err := m.SetTaskDefaults(0, defaultTaskDefaults()); !errors.Is(err, ErrDefaultsConflict) {
		t.Fatalf("stale write: %v", err)
	}
	// Fail durable replacement while keeping the in-memory value authoritative.
	blocker := filepath.Join(root, "blocked")
	if err := os.Mkdir(blocker, 0700); err != nil {
		t.Fatal(err)
	}
	s.path = blocker
	values.Connections = 12
	if _, err := m.SetTaskDefaults(1, values); err == nil {
		t.Fatal("unsafe destination accepted")
	}
	if m.TaskDefaults() != saved {
		t.Fatal("failed persistence became visible")
	}
}

func TestTaskDefaultsConcurrentImportOnlyOneWins(t *testing.T) {
	s, err := newTaskDefaultsStore(filepath.Join(t.TempDir(), "tasks.db"))
	if err != nil {
		t.Fatal(err)
	}
	m := &Manager{taskDefaults: s}
	var group sync.WaitGroup
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		group.Add(1)
		go func() { defer group.Done(); _, err := m.SetTaskDefaults(0, defaultTaskDefaults()); results <- err }()
	}
	group.Wait()
	close(results)
	success, conflict := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, ErrDefaultsConflict) {
			conflict++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("%d successes %d conflicts", success, conflict)
	}
}

func TestTaskDefaultsValidationAndExplicitOverrides(t *testing.T) {
	values := defaultTaskDefaults()
	values.Headers = `{"Cookie":"private","User-Agent":"default-agent"}`
	values.Folder = "configured"
	values.Extra = "--on-download-complete=malicious"
	if err := validateTaskDefaults(values); err == nil {
		t.Fatal("process hook accepted")
	}
	values.Extra = ""
	values.Proxy = "http://proxy.invalid\n--rpc-secret=bad"
	if err := validateTaskDefaults(values); err == nil {
		t.Fatal("newline accepted")
	}
	values.Proxy = ""
	values.Headers = strings.Repeat("x", 64*1024)
	if err := validateTaskDefaults(values); err == nil {
		t.Fatal("oversized headers accepted")
	}
	values.Headers = `{"Cookie":"private","User-Agent":"default-agent"}`
	m := &Manager{taskDefaults: &taskDefaultsStore{state: TaskDefaultsSnapshot{Values: values}}}
	folder, _, headers, opts := m.ApplyTaskDefaults("", "", map[string]string{"user-agent": "explicit"}, nil)
	if folder != "configured" || headers["user-agent"] != "explicit" || headers["User-Agent"] != "" || opts.Connections != 16 {
		t.Fatal("defaults not merged")
	}
	_, _, _, opts = m.ApplyTaskDefaults("explicit", "", nil, &Aria2Opts{Connections: 2, MaxSpeedBps: 0})
	if opts.Connections != 2 || opts.MaxSpeedBps != 0 || len(opts.ExtraArgs) != 0 {
		t.Fatal("explicit zero/options were overwritten")
	}
}
