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
