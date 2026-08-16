package downloader

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

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

	page := m.PageTaskSnapshots(0, 100, "")
	if len(page.Tasks) != 100 || page.Total != 230 || page.Summary.Total != 230 || page.Summary.Error != 2 {
		t.Fatalf("unexpected page: tasks=%d total=%d summary=%+v", len(page.Tasks), page.Total, page.Summary)
	}
	if page.Tasks[0].ID != 230 || page.Tasks[99].ID != 131 {
		t.Fatalf("page IDs are %d..%d, want 230..131", page.Tasks[0].ID, page.Tasks[99].ID)
	}
	errorPage := m.PageTaskSnapshots(0, 100, StatusError)
	if errorPage.Total != 2 || len(errorPage.Tasks) != 2 || errorPage.Tasks[0].ID != 225 {
		t.Fatalf("unexpected error page: %+v", errorPage)
	}
	oldVersion := page.Version
	if err := m.setTask(230, func(task *Task) { task.Progress = "changed" }); err != nil {
		t.Fatal(err)
	}
	if next := m.PageTaskSnapshots(0, 100, ""); next.Version == oldVersion {
		t.Fatal("page version did not change with a visible task")
	}
}

type fakeAriaRPC struct {
	mu           sync.Mutex
	paused       []string
	resumed      []string
	removed      []string
	statusValue  string
	forceRemoved bool
	stopped      bool
}

func (f *fakeAriaRPC) ready() error                       { return nil }
func (f *fakeAriaRPC) addURI(*Task, map[string]any) error { return nil }
func (f *fakeAriaRPC) status(gid string) (ariaStatus, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	status := f.statusValue
	if status == "" {
		status = "active"
		if f.forceRemoved {
			status = "removed"
		}
	}
	return ariaStatus{GID: gid, Status: status}, nil
}
func (f *fakeAriaRPC) removeResult(string) error       { return nil }
func (f *fakeAriaRPC) purgeResults() error             { return nil }
func (f *fakeAriaRPC) statuses() ([]ariaStatus, error) { return nil, nil }
func (f *fakeAriaRPC) pause(gid string) error          { f.record(&f.paused, gid); return nil }
func (f *fakeAriaRPC) unpause(gid string) error        { f.record(&f.resumed, gid); return nil }
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
		page := m.PageTaskSnapshots(0, 100, "")
		if len(page.Tasks) != 100 {
			b.Fatal(len(page.Tasks))
		}
	}
}
