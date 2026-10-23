package downloader

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

type generationRPC struct {
	*fakeAriaRPC
	states                 map[string]string
	stops, retired         []string
	stopError, retireError string
	vanishOnStop           string
	vanishAfterStop        bool
}

func TestCancelWaitsForPreviousArtifactWriter(t *testing.T) {
	m, fake := transferTestManager(t)
	task := transferTestTask(t, m, "artifact-owned.bin")
	if err := m.setTask(task.ID, func(task *Task) { task.PreviousGID = "previous"; task.Status = StatusError }); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(task.Folder, task.OutputName)
	if err := os.WriteFile(path, []byte("writing"), 0600); err != nil {
		t.Fatal(err)
	}
	canceled, done := make(chan struct{}, 1), make(chan struct{})
	defer func() {
		select {
		case <-done:
		default:
			close(done)
		}
	}()
	m.artifacts.jobs["previous"] = &artifactJob{task: task, done: done, cancel: func() {
		select {
		case canceled <- struct{}{}:
		default:
		}
	}}
	m.rpc = &generationRPC{fakeAriaRPC: fake, states: map[string]string{"previous": "active"}}
	result := make(chan TaskOperationResult, 1)
	go func() { result <- m.RemoveTasks([]int64{task.ID}) }()
	select {
	case <-canceled:
	case <-time.After(3 * time.Second):
		t.Fatal("previous artifact writer was never canceled")
	}
	select {
	case got := <-result:
		t.Fatalf("returned before writer exit: %+v", got)
	default:
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "writing" {
		t.Fatalf("writer bytes removed: %q %v", data, err)
	}
	if _, exists := m.GetTask(task.ID); !exists {
		t.Fatal("record removed while writer alive")
	}
	close(done)
	select {
	case got := <-result:
		if len(got.Succeeded) != 1 {
			t.Fatalf("cancel after writer exit: %+v", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancel did not finish after writer exit")
	}
}

func (r *generationRPC) status(gid string) (ariaStatus, error) {
	state, exists := r.states[gid]
	if !exists {
		return ariaStatus{}, errors.New("GID not found")
	}
	return ariaStatus{GID: gid, Status: state}, nil
}
func (r *generationRPC) forceRemove(gid string) error {
	r.stops = append(r.stops, gid)
	if gid == r.vanishOnStop {
		delete(r.states, gid)
		if r.vanishAfterStop {
			return nil
		}
		return errors.New("GID not found")
	}
	if gid == r.stopError {
		return errors.New("writer could not stop")
	}
	r.states[gid] = "removed"
	return nil
}

func TestCancelRetainsCompletionEvidenceAcrossRetirementFailureAndRestart(t *testing.T) {
	for _, state := range []string{"complete", "error"} {
		t.Run(state, func(t *testing.T) {
			m, fake := transferTestManager(t)
			task := transferTestTask(t, m, "preserved.bin")
			if err := m.setTask(task.ID, func(task *Task) { task.PreviousGID = "previous" }); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(task.Folder, task.OutputName)
			if err := os.WriteFile(path, []byte("preserve"), 0600); err != nil {
				t.Fatal(err)
			}
			rpc := &generationRPC{fakeAriaRPC: fake, states: map[string]string{task.GID: state, "previous": "removed"}, retireError: "previous"}
			m.rpc = rpc
			if result := m.RemoveTasks([]int64{task.ID}); len(result.Failed) != 1 {
				t.Fatalf("failure ignored: %+v", result)
			}
			if rpc.states[task.GID] != state {
				t.Fatal("preservation evidence retired too soon")
			}
			defaultDir := m.defaultDir
			m.Stop()
			var err error
			m, err = NewManager("unused", defaultDir, filepath.Join(filepath.Dir(defaultDir), "records.db"))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(m.Stop)
			m.rpc = rpc
			rpc.retireError = ""
			if result := m.RemoveTasks([]int64{task.ID}); len(result.Succeeded) != 1 {
				t.Fatalf("retry failed: %+v", result)
			}
			if data, err := os.ReadFile(path); err != nil || string(data) != "preserve" {
				t.Fatalf("completed bytes lost: %q %v", data, err)
			}
		})
	}
}

func TestCancelPreservesOutputWhenStopLosesEngineEvidence(t *testing.T) {
	for _, after := range []bool{false, true} {
		t.Run(fmt.Sprintf("after-ack=%v", after), func(t *testing.T) {
			m, fake := transferTestManager(t)
			task := transferTestTask(t, m, "unknown.bin")
			if err := m.setTask(task.ID, func(task *Task) { task.PreviousGID = "previous" }); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(task.Folder, task.OutputName)
			if err := os.WriteFile(path, []byte("possibly complete"), 0600); err != nil {
				t.Fatal(err)
			}
			rpc := &generationRPC{fakeAriaRPC: fake, states: map[string]string{task.GID: "active", "previous": "active"}, vanishOnStop: task.GID, retireError: "previous"}
			rpc.vanishAfterStop = after
			m.rpc = rpc
			if result := m.RemoveTasks([]int64{task.ID}); len(result.Failed) != 1 {
				t.Fatalf("retirement failure ignored: %+v", result)
			}
			if !reflect.DeepEqual(rpc.stops, []string{task.GID, "previous"}) {
				t.Fatalf("old writer not handled: %v", rpc.stops)
			}
			rpc.retireError = ""
			if result := m.RemoveTasks([]int64{task.ID}); len(result.Succeeded) != 1 {
				t.Fatalf("retry cancel: %+v", result)
			}
			if data, err := os.ReadFile(path); err != nil || string(data) != "possibly complete" {
				t.Fatalf("unknown bytes lost: %q %v", data, err)
			}
		})
	}
}
func (r *generationRPC) removeResult(gid string) error {
	if gid == r.retireError {
		return errors.New("engine state is busy")
	}
	r.retired = append(r.retired, gid)
	delete(r.states, gid)
	return nil
}

func TestCancelRetryRetiresPreviousGeneration(t *testing.T) {
	for _, phase := range []string{"queued", "submission-failed", "restored"} {
		t.Run(phase, func(t *testing.T) {
			m, fake := transferTestManager(t)
			task := transferTestTask(t, m, "partial.bin")
			path := filepath.Join(task.Folder, task.OutputName)
			for _, suffix := range []string{"", ".aria2"} {
				if err := os.WriteFile(path+suffix, []byte("partial"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			m.applyStatuses([]ariaStatus{{GID: task.GID, Status: "error", ErrorCode: "8"}})
			if err := m.RequeueTask(task.ID); err != nil {
				t.Fatal(err)
			}
			if phase != "queued" {
				m.rpc = &refusingRetireRPC{fake, task.GID}
				if m.submit(submission{id: task.ID}) {
					t.Fatal("retry unexpectedly admitted")
				}
			}
			if phase == "restored" {
				defaultDir := m.defaultDir
				m.Stop()
				var err error
				m, err = NewManager("unused", defaultDir, filepath.Join(filepath.Dir(defaultDir), "records.db"))
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(m.Stop)
			}
			current, exists := m.GetTask(task.ID)
			if !exists {
				t.Fatal("restored task not found")
			}
			if current.PreviousGID != task.GID || current.GID == task.GID {
				t.Fatalf("no rotated generation: %+v", current)
			}
			rpc := &generationRPC{fakeAriaRPC: fake, states: map[string]string{task.GID: "active"}}
			m.rpc = rpc
			result := m.RemoveTasks([]int64{task.ID})
			if len(result.Succeeded) != 1 || len(result.Failed) != 0 {
				t.Fatalf("cancel retry: %+v", result)
			}
			if !reflect.DeepEqual(rpc.stops, []string{task.GID}) || len(rpc.retired) != 2 {
				t.Fatalf("writer leaked: stops=%v retired=%v", rpc.stops, rpc.retired)
			}
			for _, suffix := range []string{"", ".aria2"} {
				if data, err := os.ReadFile(path + suffix); err != nil || string(data) != "partial" {
					t.Fatalf("missing engine evidence must preserve bytes: %q %v", data, err)
				}
			}
			if stored, err := m.store.LoadAll(); err != nil || len(stored) != 0 {
				t.Fatalf("record remains: %v %v", stored, err)
			}
		})
	}
}

func TestCancelPreviousGenerationFailureIsRetryable(t *testing.T) {
	for _, failure := range []string{"stop", "retire", "offline"} {
		t.Run(failure, func(t *testing.T) {
			m, fake := transferTestManager(t)
			task := transferTestTask(t, m, "partial.bin")
			if err := m.setTask(task.ID, func(task *Task) { task.PreviousGID = "previous"; task.Status = StatusError }); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(task.Folder, task.OutputName)
			if err := os.WriteFile(path, []byte("partial"), 0600); err != nil {
				t.Fatal(err)
			}
			rpc := &generationRPC{fakeAriaRPC: fake, states: map[string]string{"previous": "active"}}
			m.rpc = rpc
			switch failure {
			case "stop":
				rpc.stopError = "previous"
			case "retire":
				rpc.retireError = "previous"
			case "offline":
				m.rpc = nil
			}
			result := m.RemoveTasks([]int64{task.ID})
			if len(result.Failed) != 1 || len(result.Succeeded) != 0 {
				t.Fatalf("failure ignored: %+v", result)
			}
			if stored, err := m.store.LoadAll(); err != nil || len(stored) != 1 || stored[0].PreviousGID != "previous" {
				t.Fatalf("lost retry owner: %v %v", stored, err)
			}
			if failure != "retire" {
				if data, err := os.ReadFile(path); err != nil || string(data) != "partial" {
					t.Fatalf("live bytes lost: %q %v", data, err)
				}
			}
			rpc.stopError, rpc.retireError = "", ""
			m.rpc = rpc
			if result := m.RemoveTasks([]int64{task.ID}); len(result.Succeeded) != 1 {
				t.Fatalf("retry cancel: %+v", result)
			}
		})
	}
}

func TestCancelGenerationsPreservesCompletedOutputAndDeduplicatesGID(t *testing.T) {
	for _, same := range []bool{false, true} {
		m, fake := transferTestManager(t)
		task := transferTestTask(t, m, "complete.bin")
		old := "previous"
		if same {
			old = task.GID
		}
		if err := m.setTask(task.ID, func(task *Task) { task.PreviousGID = old }); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(task.Folder, task.OutputName)
		if err := os.WriteFile(path, []byte("complete"), 0600); err != nil {
			t.Fatal(err)
		}
		rpc := &generationRPC{fakeAriaRPC: fake, states: map[string]string{task.GID: "removed", old: "complete"}}
		m.rpc = rpc
		if result := m.RemoveTasks([]int64{task.ID}); len(result.Succeeded) != 1 {
			t.Fatalf("cancel: %+v", result)
		}
		if data, err := os.ReadFile(path); err != nil || string(data) != "complete" {
			t.Fatalf("complete bytes lost: %q %v", data, err)
		}
		want := 2
		if same {
			want = 1
		}
		if len(rpc.retired) != want {
			t.Fatalf("duplicate retirement: %v", rpc.retired)
		}
	}
}

func TestCancelRejectsPreviousGIDOwnedByAnotherTask(t *testing.T) {
	m, fake := transferTestManager(t)
	first := transferTestTask(t, m, "first.bin")
	second, _, err := m.AddTask("https://example.test/other.bin", "other.bin", "", nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	m.flushAdmissions(false)
	if err := m.setTask(first.ID, func(task *Task) { task.PreviousGID = second.GID }); err != nil {
		t.Fatal(err)
	}
	rpc := &generationRPC{fakeAriaRPC: fake, states: map[string]string{first.GID: "active", second.GID: "active"}}
	m.rpc = rpc
	result := m.RemoveTasks([]int64{first.ID})
	if len(result.Failed) != 1 || !strings.Contains(result.Failed[0].Error, "belongs to task") || len(rpc.stops) != 0 {
		t.Fatalf("foreign engine touched: %+v %v", result, rpc.stops)
	}
}
