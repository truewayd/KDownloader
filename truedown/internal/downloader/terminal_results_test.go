package downloader

import (
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

type retainedResultRPC struct {
	fakeAriaRPC
	resultOperations int
}

func (rpc *retainedResultRPC) removeResult(gid string) error {
	rpc.mu.Lock()
	defer rpc.mu.Unlock()
	rpc.resultOperations++
	rpc.statusesValue = slices.DeleteFunc(rpc.statusesValue, func(state ariaStatus) bool { return state.GID == gid })
	return nil
}

func (rpc *retainedResultRPC) purgeResults() error {
	rpc.mu.Lock()
	defer rpc.mu.Unlock()
	rpc.resultOperations++
	rpc.statusesValue = nil
	return nil
}

func TestClearDonePreservesUnobservedTerminalResults(t *testing.T) {
	for _, knownDone := range []bool{false, true} {
		t.Run(fmt.Sprintf("knownDone=%t", knownDone), func(t *testing.T) {
			root := t.TempDir()
			manager, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer manager.Stop()
			rpc := &retainedResultRPC{}
			manager.rpc = rpc
			tasks := make([]*Task, 3)
			for index := range tasks {
				tasks[index], _, err = manager.AddTask(fmt.Sprintf("https://example.test/%d.bin", index), "", "", nil, "", 0, Aria2Opts{})
				if err != nil {
					t.Fatal(err)
				}
			}
			manager.flushAdmissions(false)
			for _, task := range tasks {
				if !manager.acquireAriaSlot() || !manager.submit(submission{id: task.ID}) {
					t.Fatal("task admission failed")
				}
			}
			if knownDone {
				manager.applyStatuses([]ariaStatus{{GID: tasks[0].GID, Status: "complete"}})
			}
			rpc.mu.Lock()
			rpc.statusesValue = []ariaStatus{
				{GID: tasks[0].GID, Status: "complete"},
				{GID: tasks[1].GID, Status: "complete"},
				{GID: tasks[2].GID, Status: "error", ErrorMessage: "download failed"},
			}
			rpc.mu.Unlock()
			wantRemoved := 0
			if knownDone {
				wantRemoved = 1
			}
			if removed := manager.ClearDone(); removed != wantRemoved {
				t.Fatalf("removed=%d want=%d", removed, wantRemoved)
			}
			states, err := rpc.statuses()
			if err != nil {
				t.Fatal(err)
			}
			manager.applyStatuses(states)
			for index, wantStatus := range []Status{StatusDone, StatusError} {
				task, exists := manager.GetTask(tasks[index+1].ID)
				if !exists || task.Status != wantStatus {
					t.Fatalf("unobserved terminal result was discarded: task=%+v want=%s", task, wantStatus)
				}
			}
			if len(manager.ariaSlots) != 0 || len(manager.ariaAdmitted) != 0 {
				t.Fatalf("terminal tasks retained queue slots: slots=%d admitted=%d", len(manager.ariaSlots), len(manager.ariaAdmitted))
			}
			stored, err := manager.store.LoadAll()
			if err != nil || len(stored) != len(tasks)-wantRemoved {
				t.Fatalf("stored task count=%d err=%v", len(stored), err)
			}
		})
	}
}

func TestAriaTerminalResultRetentionIsBounded(t *testing.T) {
	manager := &Manager{defaultDir: t.TempDir()}
	args := manager.aria2StartArgs(6800, "secret", defaultRuntimeSettings())
	if !slices.Contains(args, "--keep-unfinished-download-result=false") ||
		!slices.Contains(args, fmt.Sprintf("--max-download-result=%d", 2*ariaBacklogLimit)) {
		t.Fatalf("terminal retention must bound failures and reserve a torrent parent/child window: %v", args)
	}
}

func TestClearDoneDoesNotQueryEvictedHistory(t *testing.T) {
	manager := benchmarkPageManager(10_000)
	store, err := openRecordStore(filepath.Join(t.TempDir(), "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	manager.store = store
	rpc := &retainedResultRPC{}
	manager.rpc = rpc
	if removed := manager.ClearDone(); removed != 10_000 || len(manager.tasks) != 0 {
		t.Fatalf("completed history was not cleared: removed=%d remaining=%d", removed, len(manager.tasks))
	}
	if rpc.resultOperations != 0 {
		t.Fatalf("history cleanup queried engine results %d times", rpc.resultOperations)
	}
}

func TestStatusPollPreservesNewerPauseIntent(t *testing.T) {
	for _, pause := range []bool{false, true} {
		t.Run(fmt.Sprintf("pause=%t", pause), func(t *testing.T) {
			root := t.TempDir()
			manager, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer manager.Stop()
			manager.rpc = &fakeAriaRPC{}
			task, _, err := manager.AddTask("https://example.test/pause.bin", "pause.bin", "", nil, "", 0, Aria2Opts{})
			if err != nil {
				t.Fatal(err)
			}
			manager.flushAdmissions(false)
			staleState, latestState, wantStatus := "paused", "active", StatusQueued
			if pause {
				staleState, latestState, wantStatus = "active", "paused", StatusPaused
			}
			manager.applyStatuses([]ariaStatus{{GID: task.GID, Status: staleState}})
			pollRevision := manager.revision
			if pause {
				err = manager.PauseTask(task.ID)
			} else {
				err = manager.ResumeTask(task.ID)
			}
			if err != nil {
				t.Fatal(err)
			}
			manager.applyStatusesAtRevision([]ariaStatus{{GID: task.GID, Status: staleState}}, pollRevision)
			current, _ := manager.GetTask(task.ID)
			if current.Status != wantStatus {
				t.Fatalf("stale poll overwrote local operation: status=%s want=%s", current.Status, wantStatus)
			}
			stored, err := manager.store.LoadAll()
			if err != nil || len(stored) != 1 || stored[0].Status != wantStatus {
				t.Fatalf("stale poll corrupted durable intent: tasks=%+v err=%v", stored, err)
			}
			manager.applyStatusesAtRevision([]ariaStatus{{GID: task.GID, Status: latestState}}, manager.revision)
			current, _ = manager.GetTask(task.ID)
			if current.Status != statusFromAria(latestState) {
				t.Fatalf("fresh poll was not applied: status=%s want=%s", current.Status, latestState)
			}
		})
	}
}

func TestPendingSubmissionPreservesIntentDuringEngineRecovery(t *testing.T) {
	for _, stopping := range []bool{false, true} {
		t.Run(fmt.Sprintf("stopping=%t", stopping), func(t *testing.T) {
			root := t.TempDir()
			databasePath := filepath.Join(root, "records.db")
			manager, err := NewManagerWithConfig("unused", filepath.Join(root, "downloads"), databasePath,
				ManagerConfig{EngineExit: func(*Manager, error) {}})
			if err != nil {
				t.Fatal(err)
			}
			defer manager.Stop()
			rpc := &fakeAriaRPC{}
			manager.rpc = rpc
			task, _, err := manager.AddTask("https://example.test/recover.bin", "recover.bin", "", nil, "", 0, Aria2Opts{})
			if err != nil {
				t.Fatal(err)
			}
			manager.flushAdmissions(false)
			if stopping {
				manager.cancel()
			} else {
				manager.handleUnexpectedEngineExit(errors.New("engine stopped"))
			}
			if manager.submit(submission{id: task.ID}) {
				t.Fatal("stopped manager admitted a pending task")
			}
			manager.Stop()
			reloaded, err := NewManager("unused", filepath.Join(root, "downloads"), databasePath)
			if err != nil {
				t.Fatal(err)
			}
			defer reloaded.Stop()
			stored, ok := reloaded.GetTask(task.ID)
			if !ok || stored.Status != StatusQueued || stored.Error != "" {
				t.Fatalf("pending submission destroyed recoverable intent: %+v", stored)
			}
			if len(rpc.added) != 0 {
				t.Fatalf("stopped engine received %d downloads", len(rpc.added))
			}
		})
	}
}

type interruptedAdmissionRPC struct {
	fakeAriaRPC
	entered chan struct{}
	release chan struct{}
}

func (rpc *interruptedAdmissionRPC) addURI(*Task, map[string]any) error {
	return rpc.interrupt()
}

func (rpc *interruptedAdmissionRPC) pause(string) error {
	return rpc.interrupt()
}

func (rpc *interruptedAdmissionRPC) status(gid string) (ariaStatus, error) {
	return ariaStatus{GID: gid, Status: "active", Bittorrent: &ariaBitTorrentStatus{}}, nil
}

func (rpc *interruptedAdmissionRPC) interrupt() error {
	close(rpc.entered)
	<-rpc.release
	return errors.New("engine connection was lost")
}

func TestInFlightAdmissionPreservesIntentWhenEngineStops(t *testing.T) {
	for _, native := range []bool{false, true} {
		t.Run(fmt.Sprintf("native=%t", native), func(t *testing.T) {
			root := t.TempDir()
			exited := make(chan struct{}, 1)
			manager, err := NewManagerWithConfig("unused", root, filepath.Join(root, "records.db"),
				ManagerConfig{Aria2Next: native, EngineExit: func(*Manager, error) { exited <- struct{}{} }})
			if err != nil {
				t.Fatal(err)
			}
			defer manager.Stop()
			rpc := &interruptedAdmissionRPC{entered: make(chan struct{}), release: make(chan struct{})}
			manager.rpc = rpc
			task, _, err := manager.AddTask("https://example.test/recover.bin", "recover.bin", "", nil, "", 0, Aria2Opts{})
			if err != nil {
				t.Fatal(err)
			}
			manager.flushAdmissions(false)
			wantStatus := StatusQueued
			if native {
				wantStatus = StatusPaused
				if err := manager.setTask(task.ID, func(task *Task) { task.Status = wantStatus }); err != nil {
					t.Fatal(err)
				}
			}
			finished := make(chan bool, 1)
			go func() { finished <- manager.submit(submission{id: task.ID}) }()
			select {
			case <-rpc.entered:
			case <-time.After(time.Second):
				close(rpc.release)
				t.Fatal("admission did not reach the blocking RPC")
			}
			go manager.handleUnexpectedEngineExit(errors.New("engine stopped"))
			deadline := time.Now().Add(time.Second)
			for !manager.engineExited.Load() && time.Now().Before(deadline) {
				time.Sleep(time.Millisecond)
			}
			engineExited := manager.engineExited.Load()
			close(rpc.release)
			if !engineExited {
				t.Fatal("engine exit was not detected")
			}
			select {
			case admitted := <-finished:
				if admitted {
					t.Fatal("interrupted admission was reported as successful")
				}
			case <-time.After(time.Second):
				t.Fatal("admission did not finish after engine exit")
			}
			select {
			case <-exited:
			case <-time.After(time.Second):
				t.Fatal("recovery callback did not run")
			}
			stored, err := manager.store.LoadAll()
			if err != nil || len(stored) != 1 || stored[0].Status != wantStatus || stored[0].Error != "" {
				t.Fatalf("in-flight admission lost recovery intent: tasks=%+v err=%v", stored, err)
			}
		})
	}
}

type failedAdmissionRPC struct {
	fakeAriaRPC
	err error
}

func (rpc *failedAdmissionRPC) addURI(*Task, map[string]any) error { return rpc.err }

func TestEngineExitRecoversOnlyRecentAdmissionConnectionFailures(t *testing.T) {
	for _, pause := range []bool{false, true} {
		for _, scenario := range []string{"no-poll", "older-poll", "newer-poll", "rpc-rejection"} {
			t.Run(fmt.Sprintf("pause=%t/%s", pause, scenario), func(t *testing.T) {
				root := t.TempDir()
				manager, err := NewManagerWithConfig("unused", root, filepath.Join(root, "records.db"),
					ManagerConfig{EngineExit: func(*Manager, error) {}})
				if err != nil {
					t.Fatal(err)
				}
				defer manager.Stop()
				rpc := &failedAdmissionRPC{err: errors.New("connection reset by peer")}
				if scenario == "rpc-rejection" {
					rpc.err = &ariaRPCError{Code: 1, Message: "invalid option"}
				}
				manager.rpc = rpc
				task, _, err := manager.AddTask("https://example.test/recover.bin", "recover.bin", "", nil, "", 0, Aria2Opts{})
				if err != nil {
					t.Fatal(err)
				}
				manager.flushAdmissions(false)
				wantStatus := StatusQueued
				if pause {
					wantStatus = StatusPaused
					if err := manager.setTask(task.ID, func(task *Task) { task.Status = wantStatus }); err != nil {
						t.Fatal(err)
					}
				}
				olderPollRevision := manager.revision
				if manager.submit(submission{id: task.ID}) {
					t.Fatal("failed admission was accepted")
				}
				failed, _ := manager.GetTask(task.ID)
				if failed.Status != StatusError {
					t.Fatalf("connection failure was not reported: %+v", failed)
				}
				if scenario == "older-poll" {
					manager.applyStatusesAtRevision(nil, olderPollRevision)
				}
				if scenario == "newer-poll" {
					manager.applyStatusesAtRevision(nil, manager.revision)
				}
				if scenario == "newer-poll" || scenario == "rpc-rejection" {
					wantStatus = StatusError
				}
				manager.handleUnexpectedEngineExit(errors.New("engine stopped"))
				stored, err := manager.store.LoadAll()
				if err != nil || len(stored) != 1 || stored[0].Status != wantStatus {
					t.Fatalf("incorrect admission recovery: tasks=%+v want=%s err=%v", stored, wantStatus, err)
				}
				if wantStatus != StatusError && stored[0].Error != "" {
					t.Fatalf("recovered admission retained error: %+v", stored[0])
				}
			})
		}
	}
}
