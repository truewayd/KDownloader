package downloader

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type detailRPC struct {
	fakeAriaRPC
	changes []map[string]string
	fail    bool
}

func (r *detailRPC) changeOptions(_ string, values map[string]string) error {
	if r.fail {
		return errors.New("engine rejected options")
	}
	r.changes = append(r.changes, values)
	return nil
}

func TestTaskSettingsPersistencePrivacyConflictsAndLiveSpeed(t *testing.T) {
	root := t.TempDir()
	m, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	task, _, err := m.AddTask("https://example.test/file.zip", "file.zip", "", map[string]string{"Cookie": "private-cookie"}, "", 0, Aria2Opts{ExtraArgs: []string{"--all-proxy=http://private-proxy.test"}})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for {
		rows, err := m.store.LoadAll()
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("task was never persisted")
		}
		time.Sleep(time.Millisecond)
	}
	detail, err := m.TaskDetails(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(detail)
	for _, secret := range []string{"private-cookie", "private-proxy", "extraArgs", "headers"} {
		if strings.Contains(string(data), secret) {
			t.Fatal("detail leaked private settings")
		}
	}
	values := detail.Settings
	values.Connections = 8
	changed, err := m.SetTaskSettings(task.ID, detail.SettingsRevision, values)
	if err != nil || changed.Settings.Connections != 8 {
		t.Fatal(changed, err)
	}
	if _, err := m.SetTaskSettings(task.ID, detail.SettingsRevision, values); !errors.Is(err, ErrTaskSettingsConflict) {
		t.Fatal("stale write accepted", err)
	}
	m.mu.Lock()
	m.setStatusLocked(m.tasks[task.ID], StatusDownloading)
	m.ariaAdmitted[task.ID] = true
	m.mu.Unlock()
	rpc := &detailRPC{}
	m.rpc = rpc
	values.MaxSpeedBps = 2048
	saved, err := m.SetTaskSettings(task.ID, changed.SettingsRevision, values)
	if err != nil || len(rpc.changes) != 1 || rpc.changes[0]["max-download-limit"] != "2048" {
		t.Fatal(saved, rpc.changes, err)
	}
	values.Connections = 9
	if _, err := m.SetTaskSettings(task.ID, saved.SettingsRevision, values); !IsValidationError(err) {
		t.Fatal("active connections changed", err)
	}
	values.Connections = 8
	values.MaxSpeedBps = 4096
	rpc.fail = true
	if _, err := m.SetTaskSettings(task.ID, saved.SettingsRevision, values); err == nil {
		t.Fatal("engine failure accepted")
	}
	after, _ := m.TaskDetails(task.ID)
	if after.SettingsRevision != saved.SettingsRevision || after.Settings.MaxSpeedBps != 2048 {
		t.Fatal("failed options became visible")
	}
	rpc.fail = false
	m.store.mu.Lock()
	_, err = m.store.db.Exec("CREATE TRIGGER reject_settings BEFORE UPDATE OF opts_json ON download_records BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END")
	m.store.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.SetTaskSettings(task.ID, saved.SettingsRevision, values); err == nil {
		t.Fatal("persistence failure accepted")
	}
	if len(rpc.changes) != 3 || rpc.changes[1]["max-download-limit"] != "4096" || rpc.changes[2]["max-download-limit"] != "2048" {
		t.Fatal("failed persistence did not restore the running engine", rpc.changes)
	}
	after, _ = m.TaskDetails(task.ID)
	if after.SettingsRevision != saved.SettingsRevision || after.Settings.MaxSpeedBps != 2048 {
		t.Fatal("failed persistence became visible")
	}
	persisted, err := m.store.LoadAll()
	if err != nil || persisted[0].Opts.Connections != 8 || persisted[0].Opts.MaxSpeedBps != 2048 {
		t.Fatal(persisted, err)
	}
	var identity requestIdentity
	if err := json.Unmarshal([]byte(persisted[0].RequestJSON), &identity); err != nil || identity.Opts.MaxSpeedBps != 2048 || identity.Headers["Cookie"] != "private-cookie" {
		t.Fatal("durable identity was not preserved", err)
	}
}
