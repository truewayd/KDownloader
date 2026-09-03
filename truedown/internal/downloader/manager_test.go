package downloader

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestManagerStartClassifiesMissingEngine(t *testing.T) {
	root := t.TempDir()
	manager, err := NewManager(
		filepath.Join(root, "missing-aria2.exe"),
		filepath.Join(root, "downloads"),
		filepath.Join(root, "records.db"),
	)
	if err != nil {
		t.Fatal(err)
	}
	err = manager.Start()
	manager.Stop()
	if !IsEngineStartError(err) {
		t.Fatalf("Start() error=%v, want EngineStartError", err)
	}
}

func TestAddTaskBeyondFormerQueueCapacityReturns(t *testing.T) {
	stateDir := t.TempDir()
	databasePath := filepath.Join(stateDir, "records.db")
	m, err := NewManager("unused", filepath.Join(stateDir, "downloads"), databasePath)
	if err != nil {
		t.Fatal(err)
	}

	done := make(chan error, 1)
	go func() {
		for i := 0; i < 400; i++ {
			_, duplicate, err := m.AddTask(fmt.Sprintf("https://example.test/file-%d.bin", i), "", "", nil, "", 0, Aria2Opts{})
			if err != nil {
				done <- err
				return
			}
			if duplicate {
				done <- fmt.Errorf("task %d unexpectedly reported as duplicate", i)
				return
			}
		}
		done <- nil
	}()

	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("AddTask blocked after the former 256-item channel capacity")
	}
	if got := len(m.ListTasks()); got != 400 {
		t.Fatalf("ListTasks returned %d records, want 400", got)
	}
	m.Stop()

	reopened, err := NewManager("unused", filepath.Join(stateDir, "downloads"), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Stop()
	if got := len(reopened.ListTasks()); got != 400 {
		t.Fatalf("reopened database returned %d records, want 400", got)
	}
}

func TestNormalizeRequestTreatsNilAndEmptyCollectionsEqually(t *testing.T) {
	a, err := jsonFingerprint(normalizeRequest(" https://example.test/a ", "", "", "downloads", nil, "", 0, Aria2Opts{}))
	if err != nil {
		t.Fatal(err)
	}
	b, err := jsonFingerprint(normalizeRequest("https://example.test/a", "", "", "downloads", map[string]string{}, "", 0, Aria2Opts{ExtraArgs: []string{}}))
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatalf("normalized fingerprints differ: %q != %q", a, b)
	}
}

func TestNormalizeRequestTreatsWhitespaceFolderAsDefault(t *testing.T) {
	identity := normalizeRequest("https://example.test/a", "", "  \t", "downloads", nil, "", 0, Aria2Opts{})
	if identity.Folder != filepath.Clean("downloads") {
		t.Fatalf("whitespace folder=%q", identity.Folder)
	}
}

func TestDuplicateRecheckDoesNotCommitWhenPersistenceFails(t *testing.T) {
	root := t.TempDir()
	m, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	task, _, err := m.AddTask("https://example.test/file.bin", "file.bin", "", nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		persisted, loadErr := m.store.LoadAll()
		if loadErr == nil && len(persisted) == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("task was not persisted: records=%d err=%v", len(persisted), loadErr)
		}
		time.Sleep(time.Millisecond)
	}
	if err := m.setTask(task.ID, func(current *Task) { current.Status = StatusDone }); err != nil {
		t.Fatal(err)
	}
	before, _ := m.GetTask(task.ID)
	if err := m.store.Close(); err != nil {
		t.Fatal(err)
	}
	if _, duplicate, err := m.AddTask("https://example.test/file.bin", "file.bin", "", nil, "", 0, Aria2Opts{}); err == nil || !duplicate {
		t.Fatalf("duplicate recheck err=%v duplicate=%v", err, duplicate)
	}
	after, _ := m.GetTask(task.ID)
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("failed persistence changed task: before=%+v after=%+v", before, after)
	}
}

func TestWaitForManagedCommandKillsAndReapsTimedOutProcess(t *testing.T) {
	command := exec.Command(os.Args[0], "-test.run=^TestManagedCommandChild$")
	command.Env = append(os.Environ(), "TRUEDOWN_MANAGED_COMMAND_CHILD=1")
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		done <- command.Wait()
		close(done)
	}()
	if !waitForManagedCommand(command, done, 20*time.Millisecond, 2*time.Second) {
		t.Fatal("timed-out child process was not reaped after kill")
	}
	if command.ProcessState == nil {
		t.Fatal("child process has no reaped process state")
	}
	if command.ProcessState.Success() {
		t.Fatal("timed-out child unexpectedly exited successfully after being killed")
	}
}

func TestManagedCommandChild(t *testing.T) {
	if os.Getenv("TRUEDOWN_MANAGED_COMMAND_CHILD") != "1" {
		t.Skip("only runs as the managed-command child process")
	}
	time.Sleep(30 * time.Second)
}

func TestDropboxDirectDownloadDetection(t *testing.T) {
	accepted := []string{
		"https://www.dropbox.com/s/example/archive.zip?dl=1",
		"https://dropbox.com/scl/fi/token/archive.zip?rlkey=secret&dl=1",
		"https://team.dropbox.com/scl/fi/token/archive.zip?dl=1&st=renewed",
	}
	for _, link := range accepted {
		if !isDropboxDirectDownload(link) {
			t.Fatalf("Dropbox direct link %q was not detected", link)
		}
	}
	for _, link := range []string{
		"http://www.dropbox.com/s/example/archive.zip?dl=1",
		"https://www.dropbox.com/s/example/archive.zip?dl=0",
		"https://notdropbox.com/s/example/archive.zip?dl=1",
		"https://dropbox.com.example.test/s/example/archive.zip?dl=1",
	} {
		if isDropboxDirectDownload(link) {
			t.Fatalf("non-eligible link %q was detected as Dropbox direct", link)
		}
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func TestResolveDropboxDirectURLRefreshesContentAddress(t *testing.T) {
	requests := 0
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests++
		if request.URL.Hostname() == "www.dropbox.com" {
			return &http.Response{
				StatusCode: http.StatusFound,
				Header:     http.Header{"Location": []string{"https://uc123.dl.dropboxusercontent.com/content/archive.zip"}},
				Body:       io.NopCloser(strings.NewReader("")),
				Request:    request,
			}, nil
		}
		if request.Method != http.MethodHead || request.Header.Get("Accept-Encoding") != "identity" || request.Header.Get("Range") != "" {
			t.Fatalf("unexpected metadata request: method=%s headers=%v", request.Method, request.Header)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header: http.Header{
				"Content-Disposition": []string{`attachment; filename="archive.zip"`},
				"Content-Length":      []string{"2587341388"},
				"Digest":              []string{"sha-256=stored"},
			},
			Body:    io.NopCloser(strings.NewReader("")),
			Request: request,
		}, nil
	})}
	task := &Task{
		Link:          "https://www.dropbox.com/scl/fi/token/archive.zip?rlkey=key&dl=1",
		Name:          "archive.zip",
		DropboxDirect: true,
		Headers:       map[string]string{"Accept-Encoding": "gzip"},
	}
	metadata, err := resolveDropboxDirectURL(task, client)
	if err != nil {
		t.Fatal(err)
	}
	if requests != 2 || metadata.URL != "https://uc123.dl.dropboxusercontent.com/content/archive.zip" ||
		metadata.Name != "archive.zip" || !metadata.LengthKnown || metadata.Length != 2587341388 ||
		metadata.Digest != "sha-256=stored" {
		t.Fatalf("unexpected Dropbox metadata: requests=%d metadata=%+v", requests, metadata)
	}
}

func TestResolveDropboxFolderUsesOneLongRunningGET(t *testing.T) {
	requests := 0
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests++
		if request.Method != http.MethodGet || request.Header.Get("Range") != "bytes=0-0" {
			t.Fatalf("unexpected folder archive request: method=%s headers=%v", request.Method, request.Header)
		}
		return &http.Response{
			StatusCode: http.StatusPartialContent,
			Header: http.Header{
				"Content-Disposition": []string{`attachment; filename="Shared Folder.zip"`},
				"Content-Range":       []string{"bytes 0-0/2587341388"},
			},
			Body:    io.NopCloser(strings.NewReader("x")),
			Request: &http.Request{URL: mustURL(t, "https://uc123.dl.dropboxusercontent.com/content/folder.zip")},
		}, nil
	})}
	task := &Task{Link: "https://www.dropbox.com/scl/fo/token/share?rlkey=key&dl=1", Headers: map[string]string{}}
	metadata, err := resolveDropboxDirectURL(task, client)
	if err != nil {
		t.Fatal(err)
	}
	if requests != 1 || metadata.Name != "Shared Folder.zip" || metadata.Length != 2587341388 || !metadata.LengthKnown {
		t.Fatalf("unexpected folder metadata: requests=%d metadata=%+v", requests, metadata)
	}
}

func mustURL(t *testing.T, value string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func TestValidateDropboxMetadataUsesNameSizeAndDigest(t *testing.T) {
	task := &Task{Name: "archive.zip", TotalLength: 2587341388, RemoteDigest: "sha-256=stored"}
	valid := dropboxMetadata{Name: "archive.zip", Length: 2587341388, LengthKnown: true, Digest: "sha-256=stored"}
	if err := validateDropboxMetadata(task, valid); err != nil {
		t.Fatalf("valid metadata was rejected: %v", err)
	}
	for _, changed := range []dropboxMetadata{
		{Name: "other.zip", Length: 2587341388, LengthKnown: true, Digest: "sha-256=stored"},
		{Name: "archive.zip", Length: 2587341389, LengthKnown: true, Digest: "sha-256=stored"},
		{Name: "archive.zip", Length: 2587341388, LengthKnown: true, Digest: "sha-256=changed"},
	} {
		if err := validateDropboxMetadata(task, changed); err == nil {
			t.Fatalf("changed Dropbox metadata was accepted: %+v", changed)
		}
	}
}

func TestSubmitDropboxTaskUsesStableURLAfterMetadataValidation(t *testing.T) {
	stateDir := t.TempDir()
	m, err := NewManager("unused", filepath.Join(stateDir, "downloads"), filepath.Join(stateDir, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	original := "https://www.dropbox.com/scl/fi/token/archive.zip?rlkey=key&dl=1"
	task, _, err := m.AddTask(original, "archive.zip", "", map[string]string{
		"Cookie":     "dropbox=secret",
		"User-Agent": "Test Client",
	}, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	m.flushAdmissions(false)
	m.dropboxClient = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if isDropboxHost(request.URL.Hostname()) {
			return &http.Response{
				StatusCode: http.StatusFound,
				Header:     http.Header{"Location": []string{"https://uc123.dl.dropboxusercontent.com/content/archive.zip"}},
				Body:       io.NopCloser(strings.NewReader("")),
				Request:    request,
			}, nil
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header: http.Header{
				"Content-Disposition": []string{`attachment; filename="archive.zip"`},
				"Content-Length":      []string{"1024"},
			},
			Body:    io.NopCloser(strings.NewReader("")),
			Request: request,
		}, nil
	})}
	fake := &fakeAriaRPC{}
	m.rpc = fake
	m.dropboxProxy = func(*http.Request) (*url.URL, error) {
		return url.Parse("http://127.0.0.1:10808")
	}
	if !m.submit(submission{id: task.ID}) {
		t.Fatal("Dropbox task was not admitted")
	}
	if len(fake.added) != 1 || fake.added[0].Link != original {
		t.Fatalf("aria2 received unexpected task: %+v", fake.added)
	}
	if _, leaked := fake.added[0].Headers["Cookie"]; leaked {
		t.Fatalf("Dropbox cookie was forwarded to the content host: %+v", fake.added[0].Headers)
	}
	if len(fake.addedOptions) != 1 || fake.addedOptions[0]["https-proxy"] != "http://127.0.0.1:10808" {
		t.Fatalf("aria2 did not receive the Dropbox system proxy: %+v", fake.addedOptions)
	}
	persisted, ok := m.GetTask(task.ID)
	if !ok || persisted.Link != original || persisted.TotalLength != 1024 || persisted.RemoteName != "archive.zip" {
		t.Fatalf("task did not retain shared link and metadata: %+v", persisted)
	}
}

func TestAddTaskRenewsDropboxURLForPartialResume(t *testing.T) {
	stateDir := t.TempDir()
	downloadDir := filepath.Join(stateDir, "downloads")
	databasePath := filepath.Join(stateDir, "records.db")
	m, err := NewManager("unused", downloadDir, databasePath)
	if err != nil {
		t.Fatal(err)
	}

	oldLink := "https://www.dropbox.com/scl/fi/token/archive.zip?rlkey=key&st=old&dl=1"
	task, duplicate, err := m.AddTask(oldLink, "archive.zip", "", nil, "", 0, Aria2Opts{})
	if err != nil || duplicate {
		t.Fatalf("initial AddTask: task=%v duplicate=%v err=%v", task, duplicate, err)
	}
	m.flushAdmissions(false)
	if err := os.MkdirAll(downloadDir, 0755); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"", ".aria2"} {
		if err := os.WriteFile(filepath.Join(downloadDir, task.OutputName+suffix), []byte("partial"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	m.failTask(task.ID, fmt.Errorf("expired Dropbox redirect"))

	newLink := "https://www.dropbox.com/scl/fi/token/archive.zip?rlkey=key&st=renewed&dl=1"
	renewed, duplicate, err := m.AddTask(
		newLink,
		"archive.zip",
		"",
		map[string]string{"User-Agent": "Renewed Client"},
		"https://www.dropbox.com/home",
		0,
		Aria2Opts{Connections: 4},
	)
	if err != nil || !duplicate {
		t.Fatalf("renewed AddTask: task=%v duplicate=%v err=%v", renewed, duplicate, err)
	}
	if renewed.ID != task.ID || renewed.Link != newLink || renewed.GID == task.GID {
		t.Fatalf("Dropbox task was not renewed in place: old=%+v renewed=%+v", task, renewed)
	}
	if renewed.Status != StatusQueued || renewed.Headers["User-Agent"] != "Renewed Client" || renewed.Opts.Connections != 4 {
		t.Fatalf("renewed request metadata was not applied: %+v", renewed)
	}
	if got := ariaOptions(renewed, false)["check-integrity"]; got != "true" {
		t.Fatalf("Dropbox resume check-integrity=%v, want true", got)
	}
	m.Stop()

	reopened, err := NewManager("unused", downloadDir, databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Stop()
	persisted, ok := reopened.GetTask(task.ID)
	if !ok || persisted.Link != newLink || !persisted.DropboxDirect || persisted.Status != StatusQueued {
		t.Fatalf("renewed Dropbox task was not persisted: %+v", persisted)
	}
}

func TestAddTaskRejectsUnsafeRequestFields(t *testing.T) {
	stateDir := t.TempDir()
	m, err := NewManager("unused", filepath.Join(stateDir, "downloads"), filepath.Join(stateDir, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()

	tests := []struct {
		link    string
		name    string
		headers map[string]string
	}{
		{"file:///etc/passwd", "file.bin", nil},
		{"https://example.test/file", "../escape.bin", nil},
		{"https://example.test/file", "CON.txt.backup", nil},
		{"https://example.test/file", "file.bin", map[string]string{"Cookie": "safe\r\nInjected: true"}},
		{"https://example.test/file", "file.bin", map[string]string{"Host": "internal.example"}},
	}
	for _, testCase := range tests {
		if _, _, err := m.AddTask(testCase.link, testCase.name, "", testCase.headers, "", 0, Aria2Opts{}); !IsValidationError(err) {
			t.Fatalf("request link=%q name=%q returned %v", testCase.link, testCase.name, err)
		}
	}
}

func TestProtectedAriaOptionsBlockHooksAndLocalFileAccess(t *testing.T) {
	for _, name := range []string{
		"on-download-complete", "on-bt-download-complete", "rpc-secret",
		"load-cookies", "save-cookies", "private-key", "ca-certificate", "dht-file-path",
		"parameterized-uri", "index-out", "follow-torrent", "follow-metalink",
		"max-concurrent-downloads", "max-overall-download-limit",
	} {
		if !isProtectedAriaOption(name) {
			t.Fatalf("option %q is not protected", name)
		}
	}
	if isProtectedAriaOption("user-agent") {
		t.Fatal("ordinary per-download option was unexpectedly protected")
	}
}

func TestAriaOptionsCarryTrustedDownloadCredentials(t *testing.T) {
	task := &Task{
		GID: "0123456789abcdef", Link: "https://example.test/file", Folder: t.TempDir(),
		Headers: map[string]string{
			"Cookie":     "session=secret",
			"Referer":    "https://example.test/post/1",
			"User-Agent": "Test Browser",
		},
	}
	options := ariaOptions(task, false)
	headers, ok := options["header"].([]string)
	if !ok {
		t.Fatalf("aria2 header option has type %T", options["header"])
	}
	joined := strings.Join(headers, "\n")
	for _, expected := range []string{"Cookie: session=secret", "Referer: https://example.test/post/1", "User-Agent: Test Browser"} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("aria2 headers %q do not include %q", joined, expected)
		}
	}
}

func TestTaskPageIsBoundedSummarizedAndVersioned(t *testing.T) {
	stateDir := t.TempDir()
	m, err := NewManager("unused", filepath.Join(stateDir, "downloads"), filepath.Join(stateDir, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	for i := 0; i < 230; i++ {
		if _, _, err := m.AddTask(fmt.Sprintf("https://example.test/page-%d", i), "", "", nil, "", 0, Aria2Opts{}); err != nil {
			t.Fatal(err)
		}
	}
	m.mu.Lock()
	for _, id := range []int64{5, 225} {
		task := m.tasks[id]
		m.setStatusLocked(task, StatusError)
		task.Error = "test error"
		m.touchTaskLocked(task)
	}
	m.mu.Unlock()

	page := m.PageTaskSnapshots(0, 100, "", "")
	if len(page.Tasks) != 100 || page.Total != 230 || page.Summary.Total != 230 || page.Summary.Error != 2 {
		t.Fatalf("unexpected page: tasks=%d total=%d summary=%+v", len(page.Tasks), page.Total, page.Summary)
	}
	if page.Tasks[0].ID != 230 || page.Tasks[99].ID != 131 {
		t.Fatalf("page IDs are %d..%d, want 230..131", page.Tasks[0].ID, page.Tasks[99].ID)
	}
	errorPage := m.PageTaskSnapshots(0, 100, StatusError, "")
	if errorPage.Total != 2 || len(errorPage.Tasks) != 2 || errorPage.Tasks[0].ID != 225 {
		t.Fatalf("unexpected error page: %+v", errorPage)
	}
	oldVersion := page.Version
	if err := m.setTask(230, func(task *Task) { task.Progress = "changed" }); err != nil {
		t.Fatal(err)
	}
	if next := m.PageTaskSnapshots(0, 100, "", ""); next.Version == oldVersion {
		t.Fatal("page version did not change with a visible task")
	}
	searchPage := m.PageTaskSnapshots(0, 100, "", "PAGE-22")
	if searchPage.Total != 11 || len(searchPage.Tasks) != 11 || searchPage.Tasks[0].ID != 230 {
		t.Fatalf("unexpected search page: %+v", searchPage)
	}
}

type fakeAriaRPC struct {
	mu              sync.Mutex
	paused          []string
	resumed         []string
	removed         []string
	statusValue     string
	statusErr       error
	statusPath      string
	statusesValue   []ariaStatus
	forceRemoved    bool
	stopped         bool
	added           []*Task
	addedOptions    []map[string]any
	globalOptions   []map[string]string
	pauseAllCalls   int
	unpauseAllCalls int
}

func (f *fakeAriaRPC) ready() error { return nil }
func (f *fakeAriaRPC) addURI(task *Task, options map[string]any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.added = append(f.added, cloneTask(task))
	f.addedOptions = append(f.addedOptions, options)
	return nil
}
func (f *fakeAriaRPC) status(gid string) (ariaStatus, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.statusErr != nil {
		return ariaStatus{}, f.statusErr
	}
	status := f.statusValue
	if status == "" {
		status = "active"
		if f.forceRemoved {
			status = "removed"
		}
	}
	state := ariaStatus{GID: gid, Status: status}
	if f.statusPath != "" {
		state.Files = append(state.Files, struct {
			Path string `json:"path"`
		}{Path: f.statusPath})
	}
	return state, nil
}
func (f *fakeAriaRPC) removeResult(string) error { return nil }
func (f *fakeAriaRPC) purgeResults() error       { return nil }
func (f *fakeAriaRPC) statuses() ([]ariaStatus, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]ariaStatus(nil), f.statusesValue...), f.statusErr
}
func (f *fakeAriaRPC) pause(gid string) error   { f.record(&f.paused, gid); return nil }
func (f *fakeAriaRPC) unpause(gid string) error { f.record(&f.resumed, gid); return nil }
func (f *fakeAriaRPC) pauseAll() error {
	f.mu.Lock()
	f.pauseAllCalls++
	f.mu.Unlock()
	return nil
}
func (f *fakeAriaRPC) unpauseAll() error {
	f.mu.Lock()
	f.unpauseAllCalls++
	f.mu.Unlock()
	return nil
}
func (f *fakeAriaRPC) changeGlobalOptions(options map[string]string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	copy := make(map[string]string, len(options))
	for name, value := range options {
		copy[name] = value
	}
	f.globalOptions = append(f.globalOptions, copy)
	return nil
}
func (f *fakeAriaRPC) forceRemove(gid string) error {
	f.record(&f.removed, gid)
	f.mu.Lock()
	f.forceRemoved = true
	f.mu.Unlock()
	return nil
}
func (f *fakeAriaRPC) shutdown() error { f.mu.Lock(); f.stopped = true; f.mu.Unlock(); return nil }
func (f *fakeAriaRPC) record(target *[]string, gid string) {
	f.mu.Lock()
	*target = append(*target, gid)
	f.mu.Unlock()
}

func TestBatchPauseResumeAndRemovePersistAtomically(t *testing.T) {
	stateDir := t.TempDir()
	databasePath := filepath.Join(stateDir, "records.db")
	m, err := NewManager("unused", filepath.Join(stateDir, "downloads"), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	fake := &fakeAriaRPC{}
	m.rpc = fake
	task, _, err := m.AddTask("https://example.test/batch", "batch.bin", "", nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	m.flushAdmissions(false)
	if result := m.PauseTasks([]int64{task.ID}); len(result.Succeeded) != 1 || len(result.Failed) != 0 {
		t.Fatalf("pause result: %+v", result)
	}
	if current, _ := m.GetTask(task.ID); current.Status != StatusPaused {
		t.Fatalf("paused task status is %s", current.Status)
	}
	if result := m.ResumeTasks([]int64{task.ID}); len(result.Succeeded) != 1 || len(result.Failed) != 0 {
		t.Fatalf("resume result: %+v", result)
	}
	if result := m.RemoveTasks([]int64{task.ID}); len(result.Succeeded) != 1 || len(result.Failed) != 0 {
		t.Fatalf("remove result: %+v", result)
	}
	if _, ok := m.GetTask(task.ID); ok {
		t.Fatal("removed task remains in memory")
	}
	m.Stop()

	reopened, err := NewManager("unused", filepath.Join(stateDir, "downloads"), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Stop()
	if tasks := reopened.ListTasks(); len(tasks) != 0 {
		t.Fatalf("removed task remains in database: %+v", tasks)
	}
	if len(fake.paused) != 1 || len(fake.resumed) != 1 || len(fake.removed) != 1 {
		t.Fatalf("unexpected aria calls: pause=%v resume=%v remove=%v", fake.paused, fake.resumed, fake.removed)
	}
}

func TestPauseAndResumeQueueUseAriaWideOperations(t *testing.T) {
	stateDir := t.TempDir()
	m, err := NewManager("unused", filepath.Join(stateDir, "downloads"), filepath.Join(stateDir, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	fake := &fakeAriaRPC{}
	m.rpc = fake
	for index := 0; index < 3; index++ {
		if _, _, err := m.AddTask(fmt.Sprintf("https://example.test/queue-%d", index), fmt.Sprintf("queue-%d.bin", index), "", nil, "", 0, Aria2Opts{}); err != nil {
			t.Fatal(err)
		}
	}
	m.flushAdmissions(false)
	if result := m.PauseQueue(); len(result.Succeeded) != 3 || len(result.Failed) != 0 {
		t.Fatalf("pause queue result=%+v", result)
	}
	if result := m.ResumeQueue(); len(result.Succeeded) != 3 || len(result.Failed) != 0 {
		t.Fatalf("resume queue result=%+v", result)
	}
	if fake.pauseAllCalls != 1 || fake.unpauseAllCalls != 1 || len(fake.paused) != 0 || len(fake.resumed) != 0 {
		t.Fatalf("queue RPC calls: pauseAll=%d unpauseAll=%d pause=%v resume=%v", fake.pauseAllCalls, fake.unpauseAllCalls, fake.paused, fake.resumed)
	}
}

func TestProgressSortUsesNumericPercentage(t *testing.T) {
	nine := &Task{ID: 1, Progress: "9.5% (1 B / 10 B), 1 B/s"}
	eighty := &Task{ID: 2, Progress: "80.0% (8 B / 10 B), 1 B/s"}
	if comparison := compareTasksForPage(nine, eighty, "progress"); comparison >= 0 {
		t.Fatalf("numeric progress comparison=%d", comparison)
	}
}

func TestTaskPageFastSortsPreserveGlobalOrderAndOffsets(t *testing.T) {
	m := &Manager{
		tasks: map[int64]*Task{
			1: {ID: 1, Name: "one", Status: StatusDone, Revision: 1},
			2: {ID: 2, Name: "two", Status: StatusDownloading, Revision: 2},
			3: {ID: 3, Name: "three", Status: StatusQueued, Revision: 3},
			4: {ID: 4, Name: "four", Status: StatusDownloading, Revision: 4},
		},
		orderedIDs:   []int64{1, 2, 3, 4},
		statusCounts: map[Status]int{StatusDone: 1, StatusDownloading: 2, StatusQueued: 1},
		revision:     4,
		structureRev: 4,
	}

	statusAscending := m.PageTaskSnapshotsSorted(0, 10, "", "", "status", "asc")
	if got := taskSnapshotIDs(statusAscending.Tasks); !equalInt64s(got, []int64{2, 4, 3, 1}) {
		t.Fatalf("ascending status IDs=%v", got)
	}
	statusDescending := m.PageTaskSnapshotsSorted(0, 10, "", "", "status", "desc")
	if got := taskSnapshotIDs(statusDescending.Tasks); !equalInt64s(got, []int64{1, 3, 4, 2}) {
		t.Fatalf("descending status IDs=%v", got)
	}
	idPage := m.PageTaskSnapshotsSorted(1, 2, "", "", "id", "desc")
	if got := taskSnapshotIDs(idPage.Tasks); !equalInt64s(got, []int64{3, 2}) {
		t.Fatalf("descending ID page=%v", got)
	}
}

func TestTaskPageConditionalSortHitSkipsPageMaterialization(t *testing.T) {
	m := &Manager{
		tasks: map[int64]*Task{
			1: {ID: 1, Name: "one", Status: StatusDone, Revision: 1},
			2: {ID: 2, Name: "two", Status: StatusQueued, Revision: 2},
		},
		orderedIDs:   []int64{1, 2},
		statusCounts: map[Status]int{StatusDone: 1, StatusQueued: 1},
		revision:     2,
		structureRev: 2,
	}
	page := m.PageTaskSnapshotsSorted(0, 100, "", "", "status", "asc")
	cached, notModified := m.PageTaskSnapshotsSortedIfChanged(0, 100, "", "", "status", "asc", page.Version)
	if !notModified || cached.Version != page.Version || cached.Tasks != nil {
		t.Fatalf("conditional page was materialized: notModified=%v page=%+v", notModified, cached)
	}
	m.revision++
	if _, notModified = m.PageTaskSnapshotsSortedIfChanged(0, 100, "", "", "status", "asc", page.Version); notModified {
		t.Fatal("stale sorted page validator survived a task revision")
	}
}

func TestTaskPageCaseFoldingKeepsASCIIHotPathAndUnicodeBehavior(t *testing.T) {
	if !containsFold("Creator-FILE.BIN", "file.bin") || containsFold("other.bin", "file") {
		t.Fatal("ASCII case-insensitive search is incorrect")
	}
	if !containsFold("Ärger.txt", strings.ToLower("ÄRGER")) || compareFold("Ärger", "ärger") != 0 {
		t.Fatal("Unicode case-insensitive behavior changed")
	}
}

func TestTaskUpdateSnapshotDropsUnneededCredentialContainers(t *testing.T) {
	task := &Task{
		ID: 7, Name: "file.bin", Headers: map[string]string{"Cookie": "secret"},
		Opts: Aria2Opts{ExtraArgs: []string{"--max-tries=2"}}, Status: StatusDownloading,
		Progress: "50%", Revision: 9, RemoteDigest: "digest",
	}
	snapshot := snapshotTaskUpdate(task)
	if snapshot.ID != task.ID || snapshot.Progress != task.Progress || snapshot.RemoteDigest != task.RemoteDigest {
		t.Fatalf("state update snapshot lost persisted fields: %+v", snapshot)
	}
	if snapshot.Headers != nil || snapshot.Opts.ExtraArgs != nil {
		t.Fatalf("state update snapshot retained credentials or options: %+v", snapshot)
	}
}

func taskSnapshotIDs(tasks []TaskSnapshot) []int64 {
	ids := make([]int64, len(tasks))
	for index, task := range tasks {
		ids[index] = task.ID
	}
	return ids
}

func equalInt64s(left, right []int64) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func TestRemoveQueuedTaskBeforeAriaAdmission(t *testing.T) {
	stateDir := t.TempDir()
	m, err := NewManager("unused", filepath.Join(stateDir, "downloads"), filepath.Join(stateDir, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	m.rpc = &fakeAriaRPC{statusErr: &ariaRPCError{Code: 1, Message: "GID 0123456789abcdef is not found"}}
	task, _, err := m.AddTask("https://example.test/waiting", "waiting.bin", "", nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}

	result := m.RemoveTasks([]int64{task.ID})
	if len(result.Succeeded) != 1 || len(result.Failed) != 0 {
		t.Fatalf("remove result: %+v", result)
	}
	if _, ok := m.GetTask(task.ID); ok {
		t.Fatal("queued task remains after aria2 reported its GID missing")
	}
}

func TestRemoveActiveTaskDeletesPartialFiles(t *testing.T) {
	stateDir := t.TempDir()
	downloadDir := filepath.Join(stateDir, "downloads")
	m, err := NewManager("unused", downloadDir, filepath.Join(stateDir, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	m.rpc = &fakeAriaRPC{}
	task, _, err := m.AddTask("https://example.test/partial", "partial.bin", "", nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	m.flushAdmissions(false)
	if err := os.MkdirAll(downloadDir, 0755); err != nil {
		t.Fatal(err)
	}
	outputPath := filepath.Join(downloadDir, task.OutputName)
	for _, path := range []string{outputPath, outputPath + ".aria2"} {
		if err := os.WriteFile(path, []byte("partial"), 0644); err != nil {
			t.Fatal(err)
		}
	}

	result := m.RemoveTasks([]int64{task.ID})
	if len(result.Succeeded) != 1 || len(result.Failed) != 0 {
		t.Fatalf("remove result: %+v", result)
	}
	for _, path := range []string{outputPath, outputPath + ".aria2"} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("partial file %q remains: %v", path, err)
		}
	}
}

func TestRemovePreservesFilesWhenAria2AlreadyCompleted(t *testing.T) {
	stateDir := t.TempDir()
	downloadDir := filepath.Join(stateDir, "downloads")
	m, err := NewManager("unused", downloadDir, filepath.Join(stateDir, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	fake := &fakeAriaRPC{statusValue: "complete"}
	m.rpc = fake
	task, _, err := m.AddTask("https://example.test/complete", "complete.bin", "", nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	m.flushAdmissions(false)
	if err := os.MkdirAll(downloadDir, 0755); err != nil {
		t.Fatal(err)
	}
	outputPath := filepath.Join(downloadDir, task.OutputName)
	if err := os.WriteFile(outputPath, []byte("complete"), 0644); err != nil {
		t.Fatal(err)
	}

	result := m.RemoveTasks([]int64{task.ID})
	if len(result.Succeeded) != 1 || len(result.Failed) != 0 {
		t.Fatalf("remove result: %+v", result)
	}
	if _, err := os.Stat(outputPath); err != nil {
		t.Fatalf("completed file was removed: %v", err)
	}
	if len(fake.removed) != 0 {
		t.Fatalf("completed aria2 result was force-removed: %v", fake.removed)
	}
}

func TestRemoveKeepsRecordWhenPartialPathIsUnsafe(t *testing.T) {
	stateDir := t.TempDir()
	downloadDir := filepath.Join(stateDir, "downloads")
	m, err := NewManager("unused", downloadDir, filepath.Join(stateDir, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	m.rpc = &fakeAriaRPC{}
	task, _, err := m.AddTask("https://example.test/directory", "directory.bin", "", nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	m.flushAdmissions(false)
	if err := os.MkdirAll(filepath.Join(downloadDir, task.OutputName), 0755); err != nil {
		t.Fatal(err)
	}

	result := m.RemoveTasks([]int64{task.ID})
	if len(result.Succeeded) != 0 || len(result.Failed) != 1 {
		t.Fatalf("remove result: %+v", result)
	}
	if _, ok := m.GetTask(task.ID); !ok {
		t.Fatal("task record was removed after unsafe cleanup failed")
	}
	outsidePath := filepath.Join(stateDir, "outside.bin")
	if err := os.WriteFile(outsidePath, []byte("keep"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := removePartialFiles(task, outsidePath); err == nil {
		t.Fatal("outside partial path was accepted")
	}
	if _, err := os.Stat(outsidePath); err != nil {
		t.Fatalf("outside file was changed: %v", err)
	}
}

func TestAriaAdmissionWindowIsBounded(t *testing.T) {
	m := &Manager{
		ariaSlots: make(chan struct{}, ariaBacklogLimit),
		done:      make(chan struct{}),
	}
	for index := 0; index < ariaBacklogLimit; index++ {
		if !m.acquireAriaSlot() {
			t.Fatal("slot acquisition stopped early")
		}
	}
	acquired := make(chan bool, 1)
	go func() { acquired <- m.acquireAriaSlot() }()
	select {
	case <-acquired:
		t.Fatal("admission exceeded the aria backlog limit")
	case <-time.After(25 * time.Millisecond):
	}
	m.releaseAriaSlot()
	select {
	case ok := <-acquired:
		if !ok {
			t.Fatal("waiting admission did not acquire the released slot")
		}
	case <-time.After(time.Second):
		t.Fatal("waiting admission was not released")
	}
	close(m.done)
}

func TestAddTaskReservesOutputNamesBeforeFilesExist(t *testing.T) {
	stateDir := t.TempDir()
	m, err := NewManager("unused", filepath.Join(stateDir, "downloads"), filepath.Join(stateDir, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()

	first, _, err := m.AddTask("https://example.test/first", "Live Stream.png", "", nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := m.AddTask("https://example.test/second", "Live Stream.png", "", nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	if first.OutputName != "Live Stream.png" || second.OutputName != "Live Stream(1).png" {
		t.Fatalf("reserved output names are %q and %q", first.OutputName, second.OutputName)
	}
}

func TestTaskIDsByStatusAreBounded(t *testing.T) {
	stateDir := t.TempDir()
	m, err := NewManager("unused", filepath.Join(stateDir, "downloads"), filepath.Join(stateDir, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()

	for index := 0; index < 5; index++ {
		if _, _, err := m.AddTask(fmt.Sprintf("https://example.test/%d", index), fmt.Sprintf("%d.bin", index), "", nil, "", 0, Aria2Opts{}); err != nil {
			t.Fatal(err)
		}
	}
	ids := m.TaskIDsByStatus(StatusQueued, 2)
	if len(ids) != 2 || m.TaskCountByStatus(StatusQueued) != 5 {
		t.Fatalf("ids=%v queued=%d", ids, m.TaskCountByStatus(StatusQueued))
	}
}

func TestRefreshOutputNameAvoidsFileWithoutControlFile(t *testing.T) {
	stateDir := t.TempDir()
	downloadDir := filepath.Join(stateDir, "downloads")
	m, err := NewManager("unused", downloadDir, filepath.Join(stateDir, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()

	task, _, err := m.AddTask("https://example.test/live", "Live Stream.png", "", nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(downloadDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(downloadDir, task.OutputName), []byte("existing"), 0644); err != nil {
		t.Fatal(err)
	}
	// The asynchronous admission must be persisted before refresh can update it.
	m.flushAdmissions(false)

	refreshed, err := m.refreshOutputName(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.OutputName != "Live Stream(1).png" {
		t.Fatalf("refreshed output name is %q", refreshed.OutputName)
	}
}

func TestRefreshOutputNameKeepsPartialDownloadWithControlFile(t *testing.T) {
	stateDir := t.TempDir()
	downloadDir := filepath.Join(stateDir, "downloads")
	m, err := NewManager("unused", downloadDir, filepath.Join(stateDir, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()

	task, _, err := m.AddTask("https://example.test/live", "Live Stream.png", "", nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(downloadDir, 0755); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"", ".aria2"} {
		if err := os.WriteFile(filepath.Join(downloadDir, task.OutputName+suffix), []byte("partial"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	m.flushAdmissions(false)

	refreshed, err := m.refreshOutputName(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.OutputName != "Live Stream.png" {
		t.Fatalf("partial download was renamed to %q", refreshed.OutputName)
	}
}

func TestRequeueMarksUnsatisfiedHTTPRangeForCleanRestart(t *testing.T) {
	stateDir := t.TempDir()
	m, err := NewManagerWithConfig(
		"unused",
		filepath.Join(stateDir, "downloads"),
		filepath.Join(stateDir, "records.db"),
		ManagerConfig{Aria2Next: true, Aria2NextVersion: "2.6.6"},
	)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()

	task, _, err := m.AddTask("https://example.test/file.bin", "file.bin", "", nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	m.flushAdmissions(false)
	m.pendingMu.Lock()
	m.pending = nil
	m.pendingMu.Unlock()
	if err := os.MkdirAll(task.Folder, 0755); err != nil {
		t.Fatal(err)
	}
	partialPath := filepath.Join(task.Folder, task.OutputName)
	for _, path := range []string{partialPath, partialPath + ".aria2"} {
		if err := os.WriteFile(path, []byte("stale partial"), 0600); err != nil {
			t.Fatal(err)
		}
	}

	m.mu.Lock()
	stored := m.tasks[task.ID]
	m.setStatusLocked(stored, StatusError)
	stored.Error = "The requested byte range is no longer satisfiable"
	m.touchTaskLocked(stored)
	failed := snapshotTaskUpdate(stored)
	m.mu.Unlock()
	if err := m.store.Update(failed); err != nil {
		t.Fatal(err)
	}

	result := m.RequeueTasks([]int64{task.ID})
	if len(result.Succeeded) != 1 || len(result.Failed) != 0 {
		t.Fatalf("requeue result=%+v", result)
	}
	m.pendingMu.Lock()
	if len(m.pending) != 1 || !m.pending[0].discardPartial {
		m.pendingMu.Unlock()
		t.Fatalf("pending submissions=%+v, want one clean restart", m.pending)
	}
	queued := m.pending[0]
	m.pending = nil
	m.pendingMu.Unlock()
	if got := m.tasks[task.ID].Progress; !strings.Contains(got, "restarting from zero") {
		t.Fatalf("progress=%q", got)
	}
	fake := &fakeAriaRPC{}
	m.rpc = fake
	if !m.submit(queued) {
		t.Fatal("clean restart was not admitted")
	}
	for _, path := range []string{partialPath, partialPath + ".aria2"} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("stale partial %q still exists: %v", path, err)
		}
	}
	if len(fake.added) != 1 {
		t.Fatalf("fresh aria2 submissions=%d, want 1", len(fake.added))
	}
}

func TestCleanRestartKeepsAriaPathCapturedBeforeOldResultDisappears(t *testing.T) {
	stateDir := t.TempDir()
	m, err := NewManagerWithConfig(
		"unused",
		filepath.Join(stateDir, "downloads"),
		filepath.Join(stateDir, "records.db"),
		ManagerConfig{Aria2Next: true, Aria2NextVersion: "2.6.6"},
	)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()

	task, _, err := m.AddTask("https://example.test/file.bin", "file.bin", "", nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	m.flushAdmissions(false)
	m.pendingMu.Lock()
	m.pending = nil
	m.pendingMu.Unlock()
	if err := os.MkdirAll(task.Folder, 0755); err != nil {
		t.Fatal(err)
	}
	partialPath := filepath.Join(task.Folder, task.OutputName)
	for _, path := range []string{partialPath, partialPath + ".aria2"} {
		if err := os.WriteFile(path, []byte("stale partial"), 0600); err != nil {
			t.Fatal(err)
		}
	}

	oldGID := task.GID
	state := ariaStatus{GID: oldGID, Status: "error"}
	state.Files = append(state.Files, struct {
		Path string `json:"path"`
	}{Path: partialPath})
	fake := &fakeAriaRPC{statusesValue: []ariaStatus{state}}
	m.rpc = fake
	m.mu.Lock()
	stored := m.tasks[task.ID]
	m.setStatusLocked(stored, StatusError)
	stored.Error = "The requested byte range is no longer satisfiable"
	m.touchTaskLocked(stored)
	failed := snapshotTaskUpdate(stored)
	m.mu.Unlock()
	if err := m.store.Update(failed); err != nil {
		t.Fatal(err)
	}

	result := m.RequeueTasks([]int64{task.ID})
	if len(result.Succeeded) != 1 || len(result.Failed) != 0 {
		t.Fatalf("requeue result=%+v", result)
	}
	m.pendingMu.Lock()
	queued := m.pending[0]
	m.pending = nil
	m.pendingMu.Unlock()
	if queued.partialPath != partialPath {
		t.Fatalf("captured partial path=%q, want %q", queued.partialPath, partialPath)
	}

	// Simulate aria2 evicting the old stopped result while the retry waited
	// for an admission slot. The captured direct-child path remains usable.
	fake.statusErr = errors.New("connection refused")
	m.mu.Lock()
	m.tasks[task.ID].OutputName = ""
	m.mu.Unlock()
	if !m.submit(queued) {
		t.Fatal("clean restart was not admitted after the old result disappeared")
	}
	for _, path := range []string{partialPath, partialPath + ".aria2"} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("stale partial %q still exists: %v", path, err)
		}
	}
}

func TestUnexpectedEngineExitFailsActiveTasksAndBlocksRetry(t *testing.T) {
	stateDir := t.TempDir()
	m, err := NewManager("unused", filepath.Join(stateDir, "downloads"), filepath.Join(stateDir, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	task, _, err := m.AddTask("https://example.test/file.bin", "file.bin", "", nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	m.flushAdmissions(false)

	m.handleUnexpectedEngineExit(errors.New("exit status 1"))
	failed, ok := m.GetTask(task.ID)
	if !ok || failed.Status != StatusError || !strings.Contains(failed.Error, "restart TrueDown") {
		t.Fatalf("task after engine exit=%+v", failed)
	}
	result := m.RequeueTasks([]int64{task.ID})
	if len(result.Succeeded) != 0 || len(result.Failed) != 1 || !strings.Contains(result.Failed[0].Error, "not running") {
		t.Fatalf("requeue after engine exit=%+v", result)
	}
}

func TestUnexpectedEngineExitPreservesTasksForConfiguredRecovery(t *testing.T) {
	stateDir := t.TempDir()
	exits := make(chan *Manager, 1)
	m, err := NewManagerWithConfig(
		"unused",
		filepath.Join(stateDir, "downloads"),
		filepath.Join(stateDir, "records.db"),
		ManagerConfig{EngineExit: func(source *Manager, _ error) { exits <- source }},
	)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	task, _, err := m.AddTask("https://example.test/recover.bin", "recover.bin", "", nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	pausedTask, _, err := m.AddTask("https://example.test/paused.bin", "paused.bin", "", nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	m.flushAdmissions(false)
	m.mu.Lock()
	m.setStatusLocked(m.tasks[pausedTask.ID], StatusPaused)
	m.mu.Unlock()

	m.handleUnexpectedEngineExit(errors.New("exit status 2"))
	recovering, ok := m.GetTask(task.ID)
	if !ok || recovering.Status != StatusQueued || recovering.Error != "" ||
		!strings.Contains(recovering.Progress, "recovering") {
		t.Fatalf("task prepared for recovery=%+v", recovering)
	}
	paused, ok := m.GetTask(pausedTask.ID)
	if !ok || paused.Status != StatusPaused || paused.Error != "" || !strings.Contains(paused.Progress, "recovering") {
		t.Fatalf("paused task prepared for recovery=%+v", paused)
	}
	select {
	case source := <-exits:
		if source != m {
			t.Fatalf("recovery source=%p, want %p", source, m)
		}
	case <-time.After(time.Second):
		t.Fatal("engine recovery callback was not invoked")
	}
}

func TestRequiresCleanHTTPRestartIsSpecific(t *testing.T) {
	if !requiresCleanHTTPRestart("The requested byte range is no longer satisfiable") {
		t.Fatal("expected Aria2 Next range mismatch to require a clean restart")
	}
	if requiresCleanHTTPRestart("timeout while connecting") {
		t.Fatal("ordinary network errors must retain partial data")
	}
}

func jsonFingerprint(identity requestIdentity) (string, error) {
	data, err := json.Marshal(identity)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

func BenchmarkPageTaskSnapshots100Of10000(b *testing.B) {
	m := &Manager{
		tasks:        make(map[int64]*Task, 10_000),
		orderedIDs:   make([]int64, 0, 10_000),
		statusCounts: map[Status]int{StatusDone: 10_000},
		structureRev: 1,
	}
	for id := int64(1); id <= 10_000; id++ {
		m.tasks[id] = &Task{ID: id, Name: "file.bin", Status: StatusDone, Revision: id}
		m.orderedIDs = append(m.orderedIDs, id)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		page := m.PageTaskSnapshots(0, 100, "", "")
		if len(page.Tasks) != 100 {
			b.Fatal(len(page.Tasks))
		}
	}
}

func BenchmarkPageTaskSnapshotsStatusSorted100Of10000(b *testing.B) {
	m := benchmarkPageManager(10_000)
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		page := m.PageTaskSnapshotsSorted(0, 100, "", "", "status", "asc")
		if len(page.Tasks) != 100 {
			b.Fatal(len(page.Tasks))
		}
	}
}

func BenchmarkPageTaskSnapshotsSearch100Of10000(b *testing.B) {
	m := benchmarkPageManager(10_000)
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		page := m.PageTaskSnapshots(0, 100, "", "FILE.BIN")
		if len(page.Tasks) != 100 {
			b.Fatal(len(page.Tasks))
		}
	}
}

func BenchmarkPageTaskSnapshotsConditionalStatusHit10000(b *testing.B) {
	m := benchmarkPageManager(10_000)
	page := m.PageTaskSnapshotsSorted(0, 100, "", "", "status", "asc")
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		cached, notModified := m.PageTaskSnapshotsSortedIfChanged(0, 100, "", "", "status", "asc", page.Version)
		if !notModified || cached.Tasks != nil {
			b.Fatal("conditional page miss")
		}
	}
}

func benchmarkPageManager(count int) *Manager {
	m := &Manager{
		tasks:        make(map[int64]*Task, count),
		orderedIDs:   make([]int64, 0, count),
		statusCounts: map[Status]int{StatusDone: count},
		structureRev: int64(count),
		revision:     int64(count),
	}
	for id := int64(1); id <= int64(count); id++ {
		m.tasks[id] = &Task{ID: id, Name: "file.bin", Link: "https://example.test/file.bin", Status: StatusDone, Revision: id}
		m.orderedIDs = append(m.orderedIDs, id)
	}
	return m
}
