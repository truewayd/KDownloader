package downloader

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

func TestAriaHTTPRepeatedInterruptedRetriesKeepOneOutput(t *testing.T) {
	if os.Getenv("TRUEDOWN_INTEGRATION") == "" {
		t.Skip("set TRUEDOWN_INTEGRATION=1 to run real aria2 transfer tests")
	}
	engine, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	payload := make([]byte, 2*1024*1024)
	for i := range payload {
		payload[i] = byte((i*31 + i/257) % 251)
	}
	var fail atomic.Bool
	fail.Store(true)
	var resumed atomic.Int32
	var modified atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") != "" {
			resumed.Add(1)
		}
		if fail.Load() {
			w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(payload[:64*1024])
			return
		}
		data := payload
		stamp := time.Unix(1_700_000_000, 0)
		if modified.Load() {
			data = bytes.Repeat([]byte{0xa7}, len(payload))
			stamp = stamp.Add(time.Hour)
		}
		http.ServeContent(w, r, "payload.bin", stamp, bytes.NewReader(data))
	}))
	defer server.Close()
	root := t.TempDir()
	m, err := NewManager(engine, filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	opts := Aria2Opts{Connections: 1, MaxTries: 1, RetryWait: 1, ExtraArgs: []string{"--file-allocation=trunc"}}
	task, _, err := m.AddTask(server.URL+"/payload.bin", "payload.bin", "", nil, "", 0, opts)
	if err != nil {
		t.Fatal(err)
	}
	waitForStatus(t, m, task.ID, 12*time.Second, StatusError)
	path := filepath.Join(task.Folder, task.OutputName)
	// Losing the piece map of a fully preallocated file must never result in
	// a numbered replacement or a false successful download based on size.
	for attempt := 0; attempt < 3; attempt++ {
		if err := os.Remove(path + ".aria2"); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
		if err := os.Truncate(path, int64(len(payload))); err != nil {
			t.Fatal(err)
		}
		if attempt%2 == 0 {
			err = m.RequeueTask(task.ID)
		} else {
			_, _, err = m.AddTask(task.Link, task.Name, "", nil, "", 0, opts)
		}
		if err != nil {
			t.Fatal(err)
		}
		waitForStatus(t, m, task.ID, 12*time.Second, StatusError)
		current, _ := m.GetTask(task.ID)
		if current.OutputName != task.OutputName {
			t.Fatalf("retry %d renamed output: %q", attempt, current.OutputName)
		}
		assertTransferDirectory(t, task.Folder, task.OutputName, false)
	}
	// Keep this attempt's real aria2 control file to exercise byte-range resume.
	fail.Store(false)
	resumed.Store(0)
	if err := m.RequeueTask(task.ID); err != nil {
		t.Fatal(err)
	}
	waitForStatus(t, m, task.ID, 12*time.Second, StatusDone)
	assertTransferHash(t, path, payload)
	if resumed.Load() == 0 {
		t.Fatal("valid control-file retry did not issue a range request")
	}
	assertTransferDirectory(t, task.Folder, task.OutputName, true)

	// Refreshing a completed object of the same size must replace its bytes,
	// while a subsequent conditional 304 must preserve the complete output.
	modified.Store(true)
	for attempt := 0; attempt < 2; attempt++ {
		if _, _, err := m.AddTask(task.Link, task.Name, "", nil, "", 0, opts); err != nil {
			t.Fatal(err)
		}
		waitForStatus(t, m, task.ID, 12*time.Second, StatusDone)
		assertTransferHash(t, path, bytes.Repeat([]byte{0xa7}, len(payload)))
		assertTransferDirectory(t, task.Folder, task.OutputName, true)
	}
}

func TestAriaHTTPOwnedOutputWithoutControlRestoresAfterRestart(t *testing.T) {
	if os.Getenv("TRUEDOWN_INTEGRATION") == "" {
		t.Skip("set TRUEDOWN_INTEGRATION=1 to run real aria2 transfer tests")
	}
	engine, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	payload := bytes.Repeat([]byte("restore exact content\n"), 8192)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeContent(w, r, "file.bin", time.Time{}, bytes.NewReader(payload))
	}))
	defer server.Close()
	root := t.TempDir()
	database := filepath.Join(root, "records.db")
	folder := filepath.Join(root, "downloads")
	m, err := NewManager(engine, folder, database)
	if err != nil {
		t.Fatal(err)
	}
	task, _, err := m.AddTask(server.URL+"/file.bin", "file.bin", "", nil, "", 0, Aria2Opts{})
	if err != nil {
		m.Stop()
		t.Fatal(err)
	}
	m.flushAdmissions(false)
	if _, err := m.prepareHTTPOutput(task.ID, false); err != nil {
		m.Stop()
		t.Fatal(err)
	}
	m.Stop()
	if err := os.MkdirAll(task.Folder, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(task.Folder, task.OutputName)
	if err := os.WriteFile(path, make([]byte, len(payload)), 0600); err != nil {
		t.Fatal(err)
	}
	restored, err := NewManager(engine, folder, database)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Stop()
	if err := restored.Start(); err != nil {
		t.Fatal(err)
	}
	waitForStatus(t, restored, task.ID, 12*time.Second, StatusDone)
	assertTransferHash(t, path, payload)
	assertTransferDirectory(t, task.Folder, task.OutputName, true)

	// A corrupt piece map must become an actionable error and a clean retry,
	// even when the payload happens to have the expected preallocated size.
	if err := os.WriteFile(path+".aria2", []byte{0xfe, 0xff}, 0600); err != nil {
		t.Fatal(err)
	}
	restored.failTask(task.ID, errors.New("interrupted fixture transfer"))
	if err := restored.RequeueTask(task.ID); err != nil {
		t.Fatal(err)
	}
	waitForStatus(t, restored, task.ID, 12*time.Second, StatusError)
	failed, _ := restored.GetTask(task.ID)
	if failed.TransferState != transferRestart {
		t.Fatalf("corrupt control file did not schedule a clean restart: %+v", failed)
	}
	if err := restored.RequeueTask(task.ID); err != nil {
		t.Fatal(err)
	}
	waitForStatus(t, restored, task.ID, 12*time.Second, StatusDone)
	assertTransferHash(t, path, payload)
	assertTransferDirectory(t, task.Folder, task.OutputName, true)
}

func assertTransferHash(t *testing.T, path string, want []byte) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil || sha256.Sum256(data) != sha256.Sum256(want) {
		t.Fatalf("completed file content differs: bytes=%d expected=%d err=%v", len(data), len(want), err)
	}
}

func assertTransferDirectory(t *testing.T, folder, name string, complete bool) {
	t.Helper()
	entries, err := os.ReadDir(folder)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() != name && (complete || entry.Name() != name+".aria2") {
			t.Fatalf("unexpected leftover output: %s", entry.Name())
		}
	}
	if complete && len(entries) != 1 {
		t.Fatalf("completed download has %d files", len(entries))
	}
}
