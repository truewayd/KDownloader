package downloader

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func transferTestManager(t *testing.T) (*Manager, *fakeAriaRPC) {
	t.Helper()
	root := t.TempDir()
	m, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Stop)
	rpc := &fakeAriaRPC{}
	m.rpc = rpc
	return m, rpc
}

func transferTestTask(t *testing.T, m *Manager, name string) *Task {
	t.Helper()
	task, _, err := m.AddTask("https://example.test/file.bin", name, "", nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	m.flushAdmissions(false)
	if !m.submit(submission{id: task.ID}) {
		t.Fatal("initial submission failed")
	}
	task, _ = m.GetTask(task.ID)
	return task
}

func TestHTTPRepeatedRetriesKeepOwnedPathWithoutControlFile(t *testing.T) {
	for _, duplicateAdd := range []bool{false, true} {
		t.Run(map[bool]string{false: "retry", true: "duplicate-add"}[duplicateAdd], func(t *testing.T) {
			m, rpc := transferTestManager(t)
			task := transferTestTask(t, m, "file(5)(4).bin")
			path := filepath.Join(task.Folder, task.OutputName)
			for attempt := 0; attempt < 5; attempt++ {
				if err := os.WriteFile(path, make([]byte, 1024), 0600); err != nil {
					t.Fatal(err)
				}
				current, _ := m.GetTask(task.ID)
				m.applyStatuses([]ariaStatus{{GID: current.GID, Status: "error", ErrorMessage: "connection closed"}})
				if duplicateAdd {
					if _, duplicate, err := m.AddTask(task.Link, task.Name, "", nil, "", 0, task.Opts); err != nil || !duplicate {
						t.Fatalf("duplicate=%v err=%v", duplicate, err)
					}
				} else if err := m.RequeueTask(task.ID); err != nil {
					t.Fatal(err)
				}
				if !m.submit(submission{id: task.ID}) {
					t.Fatal("retry submission failed")
				}
				current, _ = m.GetTask(task.ID)
				if current.OutputName != task.OutputName {
					t.Fatalf("retry changed output to %q", current.OutputName)
				}
				if pathExists(path) {
					t.Fatal("untracked sparse/partial file was kept for unsafe length-based resume")
				}
				options := rpc.addedOptions[len(rpc.addedOptions)-1]
				if options["conditional-get"] == "true" || options["allow-overwrite"] != "false" {
					t.Fatalf("failed task entered completed-file recheck: %v", options)
				}
			}
			entries, err := os.ReadDir(task.Folder)
			if err != nil || len(entries) != 0 {
				t.Fatalf("retry left numbered files: %v, %v", entries, err)
			}
		})
	}
}

func TestHTTPResumeKeepsBothFilesAndPinsUnnamedTask(t *testing.T) {
	m, rpc := transferTestManager(t)
	task := transferTestTask(t, m, "")
	if task.OutputName != "file.bin" || rpc.addedOptions[0]["out"] != "file.bin" {
		t.Fatal("unnamed HTTP task was left to engine renaming")
	}
	for _, suffix := range []string{"", ".aria2"} {
		if err := os.WriteFile(filepath.Join(task.Folder, task.OutputName+suffix), []byte("resume data"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	m.applyStatuses([]ariaStatus{{GID: task.GID, Status: "error", ErrorMessage: "timeout"}})
	if err := m.RequeueTask(task.ID); err != nil || !m.submit(submission{id: task.ID}) {
		t.Fatal("resume failed", err)
	}
	for _, suffix := range []string{"", ".aria2"} {
		data, err := os.ReadFile(filepath.Join(task.Folder, task.OutputName+suffix))
		if err != nil || string(data) != "resume data" {
			t.Fatalf("valid resume file changed: %s, %v", suffix, err)
		}
	}
}

func TestHTTPQueuedRestartSurvivesDatabaseReopen(t *testing.T) {
	m, _ := transferTestManager(t)
	task := transferTestTask(t, m, "file.bin")
	for _, suffix := range []string{"", ".aria2"} {
		if err := os.WriteFile(filepath.Join(task.Folder, task.OutputName+suffix), []byte("stale"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	m.applyStatuses([]ariaStatus{{GID: task.GID, Status: "error", ErrorCode: "8", ErrorMessage: "remote does not support resume"}})
	if err := m.RequeueTask(task.ID); err != nil {
		t.Fatal(err)
	}
	m.Stop()
	restored, err := NewManager("unused", m.defaultDir, filepath.Join(filepath.Dir(m.defaultDir), "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Stop()
	restored.rpc = &fakeAriaRPC{}
	current, _ := restored.GetTask(task.ID)
	if current.TransferState != transferRestart || current.OutputName != task.OutputName {
		t.Fatalf("queued restart lost intent: %+v", current)
	}
	if !restored.submit(submission{id: task.ID}) {
		t.Fatal("restored restart failed")
	}
	for _, suffix := range []string{"", ".aria2"} {
		if pathExists(filepath.Join(task.Folder, task.OutputName+suffix)) {
			t.Fatal("restart kept stale bytes after reopen")
		}
	}
}

func TestHTTPPendingTaskDoesNotAdoptForeignResumePair(t *testing.T) {
	m, _ := transferTestManager(t)
	task, _, err := m.AddTask("https://example.test/file", "file.bin", "", nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	m.flushAdmissions(false)
	if err := os.MkdirAll(task.Folder, 0700); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"", ".aria2"} {
		if err := os.WriteFile(filepath.Join(task.Folder, task.OutputName+suffix), []byte("foreign"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if !m.submit(submission{id: task.ID}) {
		t.Fatal("submission failed")
	}
	current, _ := m.GetTask(task.ID)
	if current.OutputName != "file(1).bin" {
		t.Fatalf("foreign pair adopted: %s", current.OutputName)
	}
	for _, suffix := range []string{"", ".aria2"} {
		data, err := os.ReadFile(filepath.Join(task.Folder, task.OutputName+suffix))
		if err != nil || string(data) != "foreign" {
			t.Fatal("foreign file changed", err)
		}
	}
}

func TestHTTPOutputReservationRollsBackOnPersistenceFailure(t *testing.T) {
	m, _ := transferTestManager(t)
	task, _, err := m.AddTask("https://example.test/file", "file.bin", "", nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	m.flushAdmissions(false)
	if err := os.MkdirAll(task.Folder, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(task.Folder, task.OutputName), []byte("foreign"), 0600); err != nil {
		t.Fatal(err)
	}
	before, _ := m.GetTask(task.ID)
	if err := m.store.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := m.prepareHTTPOutput(task.ID, false); err == nil {
		t.Fatal("failed persistence was ignored")
	}
	after, _ := m.GetTask(task.ID)
	if !reflect.DeepEqual(before, after) || m.outputNames[outputNameKey(task.Folder, task.OutputName)] != task.ID {
		t.Fatal("failed persistence changed output ownership")
	}
}

func TestHTTPRecheckOnlyAppliesToCompletedFiles(t *testing.T) {
	m, rpc := transferTestManager(t)
	task := transferTestTask(t, m, "file.bin")
	if err := os.WriteFile(filepath.Join(task.Folder, task.OutputName), []byte("complete"), 0600); err != nil {
		t.Fatal(err)
	}
	m.applyStatuses([]ariaStatus{{GID: task.GID, Status: "complete"}})
	if _, _, err := m.AddTask(task.Link, task.Name, "", nil, "", 0, task.Opts); err != nil {
		t.Fatal(err)
	}
	if !m.submit(submission{id: task.ID}) {
		t.Fatal("completed recheck failed")
	}
	options := rpc.addedOptions[len(rpc.addedOptions)-1]
	if options["conditional-get"] != "true" || options["continue"] != "false" {
		t.Fatalf("unsafe completed-file refresh: %v", options)
	}
	current, _ := m.GetTask(task.ID)
	if current.TransferState != transferResume {
		t.Fatal("interrupted refresh would reuse partial bytes for a conditional request")
	}
}

func TestHTTPOutputOptionsCannotBypassResumeRules(t *testing.T) {
	task := &Task{Opts: Aria2Opts{ExtraArgs: []string{
		"--auto-file-renaming=true", "--allow-overwrite=true", "--always-resume=false",
		"--remove-control-file=true", "--allow-piece-length-change=true", "--force-save=false",
	}}}
	options := ariaOptions(task, false)
	for name, want := range map[string]string{"auto-file-renaming": "false", "allow-overwrite": "false", "always-resume": "true"} {
		if options[name] != want {
			t.Fatalf("%s=%v", name, options[name])
		}
	}
	for _, name := range []string{"remove-control-file", "allow-piece-length-change", "force-save"} {
		if _, exists := options[name]; exists {
			t.Fatalf("unsafe override %s survived", name)
		}
	}
}

func TestOutputNameExhaustionNeverReturnsOccupiedName(t *testing.T) {
	calls := 0
	name := resolveAvailableOutputName("file.bin", func(string) bool { calls++; return false })
	if name != "" || calls != 10000 {
		t.Fatalf("exhausted allocation returned %q after %d attempts", name, calls)
	}
}

func TestPartialCleanupValidatesPairBeforeDeletingEitherFile(t *testing.T) {
	folder := t.TempDir()
	task := &Task{Folder: folder, OutputName: "file.bin"}
	if err := os.WriteFile(filepath.Join(folder, task.OutputName), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(folder, task.OutputName+".aria2"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := removePartialFiles(task, ""); err == nil {
		t.Fatal("unsafe control-file directory accepted")
	}
	if data, err := os.ReadFile(filepath.Join(folder, task.OutputName)); err != nil || string(data) != "keep" {
		t.Fatal("payload removed before discovering invalid control path")
	}
}

type refusingRetireRPC struct {
	*fakeAriaRPC
	activeGID string
}

func (r *refusingRetireRPC) removeResult(gid string) error {
	if gid == r.activeGID {
		return errors.New("download is still active")
	}
	return nil
}

func TestRetryCannotDeletePartialWhenOldEngineTaskIsStillActive(t *testing.T) {
	m, rpc := transferTestManager(t)
	task := transferTestTask(t, m, "file.bin")
	path := filepath.Join(task.Folder, task.OutputName)
	if err := os.WriteFile(path, []byte("active data"), 0600); err != nil {
		t.Fatal(err)
	}
	m.applyStatuses([]ariaStatus{{GID: task.GID, Status: "error", ErrorCode: "8"}})
	m.rpc = &refusingRetireRPC{rpc, task.GID}
	for attempt := 0; attempt < 3; attempt++ {
		if err := m.RequeueTask(task.ID); err != nil {
			t.Fatal(err)
		}
		if m.submit(submission{id: task.ID}) {
			t.Fatal("retry admitted while old writer was active")
		}
		current, _ := m.GetTask(task.ID)
		if current.PreviousGID != task.GID {
			t.Fatal("retry forgot the original active writer")
		}
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "active data" {
		t.Fatal("active writer's output was removed")
	}
	current, _ := m.GetTask(task.ID)
	if !strings.Contains(current.Error, "retire previous") {
		t.Fatalf("missing actionable error: %+v", current)
	}
}

func TestStaleQueuedSubmissionCannotApplyOldRecheckIntent(t *testing.T) {
	m, rpc := transferTestManager(t)
	task := transferTestTask(t, m, "file.bin")
	m.applyStatuses([]ariaStatus{{GID: task.GID, Status: "error", ErrorMessage: "timeout"}})
	if err := m.RequeueTask(task.ID); err != nil {
		t.Fatal(err)
	}
	if m.submit(submission{id: task.ID, gid: task.GID, recheck: true}) {
		t.Fatal("stale submission was admitted")
	}
	if len(rpc.added) != 1 {
		t.Fatal("stale submission reached engine")
	}
	if !m.submit(submission{id: task.ID}) {
		t.Fatal("current retry did not run")
	}
}

func TestHTTPRetrySchemaMigratesExistingRecords(t *testing.T) {
	m, _ := transferTestManager(t)
	task := transferTestTask(t, m, "file(2).bin")
	database := filepath.Join(filepath.Dir(m.defaultDir), "records.db")
	m.Stop()
	db, err := openSQLite(database)
	if err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{
		"ALTER TABLE download_records DROP COLUMN transfer_state",
		"ALTER TABLE download_records DROP COLUMN previous_gid",
		"PRAGMA user_version=6",
	} {
		if _, err := db.Exec(query); err != nil {
			db.Close()
			t.Fatal(err)
		}
	}
	db.Close()
	restored, err := NewManager("unused", m.defaultDir, database)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Stop()
	current, _ := restored.GetTask(task.ID)
	if current.TransferState != transferResume || current.PreviousGID != "" || current.OutputName != task.OutputName || current.GID != task.GID {
		t.Fatalf("migration lost legacy identity: %+v", current)
	}
}

func TestHTTPRestartRefusesAnotherTasksRecordedOutput(t *testing.T) {
	m, _ := transferTestManager(t)
	task := transferTestTask(t, m, "file.bin")
	path := filepath.Join(task.Folder, task.OutputName)
	if err := os.WriteFile(path, []byte("other task"), 0600); err != nil {
		t.Fatal(err)
	}
	m.applyStatuses([]ariaStatus{{GID: task.GID, Status: "error", ErrorCode: "8"}})
	if err := m.RequeueTask(task.ID); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	m.outputNames[outputNameKey(task.Folder, task.OutputName)] = task.ID + 1
	m.mu.Unlock()
	if m.submit(submission{id: task.ID}) {
		t.Fatal("shared legacy output was deleted")
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "other task" {
		t.Fatal("other task's data changed")
	}
}
