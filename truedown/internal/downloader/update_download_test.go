package downloader

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestUpdateWaitEndsOnRemovalCancellationOrEngineExit(t *testing.T) {
	for _, reason := range []string{"removed", "canceled", "exited"} {
		t.Run(reason, func(t *testing.T) {
			root := t.TempDir()
			m, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer m.Stop()
			m.rpc = &fakeAriaRPC{}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			finished := make(chan error, 1)
			go func() {
				_, err := m.DownloadUpdate(ctx, "http://127.0.0.1/update/fixture", "update.zip", root, 64, Aria2Opts{})
				finished <- err
			}()
			deadline := time.Now().Add(2 * time.Second)
			for len(m.ListTasks()) == 0 && time.Now().Before(deadline) {
				time.Sleep(10 * time.Millisecond)
			}
			tasks := m.ListTasks()
			if len(tasks) != 1 {
				t.Fatal("update task was not created")
			}
			switch reason {
			case "removed":
				if result := m.RemoveTasks([]int64{tasks[0].ID}); len(result.Failed) != 0 {
					t.Fatal(result)
				}
			case "canceled":
				cancel()
			case "exited":
				m.engineExited.Store(true)
			}
			select {
			case err := <-finished:
				if err == nil || !strings.Contains(err.Error(), reason) {
					t.Fatalf("%s: %v", reason, err)
				}
				if reason != "removed" {
					m.applyStatuses([]ariaStatus{{GID: tasks[0].GID, Status: "paused"}})
					state, exists := m.GetTask(tasks[0].ID)
					if !exists || state.Status != StatusError {
						t.Fatal("interrupted update blocks the idle queue", state)
					}
				}
			case <-time.After(2 * time.Second):
				t.Fatal("update waiter remained stuck")
			}
		})
	}
}

func TestUpdateObserverTracksOwnedTaskAndPause(t *testing.T) {
	root := t.TempDir()
	m, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	m.rpc = &fakeAriaRPC{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	observed := make(chan TaskSnapshot, 16)
	finished := make(chan error, 1)
	go func() {
		_, err := m.DownloadUpdate(ctx, "http://127.0.0.1/update/fixture", "update.zip", root, 1024, Aria2Opts{}, func(task TaskSnapshot) {
			select {
			case observed <- task:
			default:
			}
		})
		finished <- err
	}()
	var id int64
	select {
	case task := <-observed:
		id = task.ID
	case <-time.After(2 * time.Second):
		t.Fatal("no initial update progress")
	}
	for _, status := range []Status{StatusDownloading, StatusPaused} {
		if err := m.setTask(id, func(task *Task) {
			task.Status, task.CompletedLength, task.TotalLength, task.DownloadSpeed = status, 256, 1024, 64
		}); err != nil {
			t.Fatal(err)
		}
		deadline := time.After(2 * time.Second)
	waitStatus:
		for {
			select {
			case task := <-observed:
				if task.Status != status {
					continue
				}
				if task.ID != id || task.CompletedLength != 256 || task.TotalLength != 1024 || task.DownloadSpeed != 64 {
					t.Fatalf("wrong progress: %+v", task)
				}
				break waitStatus
			case <-deadline:
				t.Fatalf("missing %s progress", status)
			}
		}
	}
	cancel()
	select {
	case err := <-finished:
		if err == nil {
			t.Fatal("cancellation reported success")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("observer prevented cancellation")
	}
}
