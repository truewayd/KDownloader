package downloader

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestTaskChangeWaitWakesAllReadersAndHonorsCancellation(t *testing.T) {
	m := benchmarkPageManager(2)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	results := make(chan int64, 8)
	for i := 0; i < 8; i++ {
		go func() { revision, _ := m.WaitTaskChanges(ctx, 2, time.Second); results <- revision }()
	}
	// Wait for an actual subscription so the test also covers wakeup delivery.
	for {
		m.mu.RLock()
		subscribed := m.listChanged != nil
		m.mu.RUnlock()
		if subscribed {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("no subscriber")
		case <-time.After(time.Millisecond):
		}
	}
	m.mu.Lock()
	m.touchTaskLocked(m.tasks[1])
	m.mu.Unlock()
	for i := 0; i < 8; i++ {
		select {
		case revision := <-results:
			if revision != 3 {
				t.Fatalf("revision=%d", revision)
			}
		case <-ctx.Done():
			t.Fatal("reader did not wake")
		}
	}
	if revision, err := m.WaitTaskChanges(ctx, 2, time.Second); err != nil || revision != 3 {
		t.Fatalf("lost change: %d %v", revision, err)
	}
	if revision, err := m.WaitTaskChanges(ctx, 3, 0); err != nil || revision != 3 {
		t.Fatalf("timeout snapshot: %d %v", revision, err)
	}
	canceled, stop := context.WithCancel(context.Background())
	stop()
	if _, err := m.WaitTaskChanges(canceled, 3, time.Second); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
}

func TestTaskPageSeparatesOrderRowsAndOverviewVersions(t *testing.T) {
	m := benchmarkPageManager(300)
	for _, task := range m.tasks {
		m.indexTaskOverviewLocked(task)
	}
	first := m.PageTaskSnapshotsSorted(0, 100, "", "", "id", "asc")
	m.mu.Lock()
	m.tasks[250].CompletedLength++
	m.touchTaskLocked(m.tasks[250])
	m.mu.Unlock()
	offscreen := m.PageTaskSnapshotsSorted(0, 100, "", "", "id", "asc")
	if first.Version == offscreen.Version || first.RowsVersion != offscreen.RowsVersion || first.OrderVersion != offscreen.OrderVersion {
		t.Fatal("offscreen progress must change only the overview validator")
	}
	m.mu.Lock()
	m.tasks[1].CompletedLength++
	m.touchTaskLocked(m.tasks[1])
	m.mu.Unlock()
	visible := m.PageTaskSnapshotsSorted(0, 100, "", "", "id", "asc")
	if visible.RowsVersion == first.RowsVersion || visible.OrderVersion != first.OrderVersion {
		t.Fatal("visible progress must change rows but not ID ordering")
	}
	progress := m.PageTaskSnapshotsSorted(0, 100, "", "", "progress", "asc")
	m.mu.Lock()
	m.tasks[1].Progress = "40%"
	m.touchTaskLocked(m.tasks[1])
	m.mu.Unlock()
	if next := m.PageTaskSnapshotsSorted(0, 100, "", "", "progress", "asc"); next.OrderVersion == progress.OrderVersion {
		t.Fatal("progress sorting must invalidate ranges")
	}
	m.mu.Lock()
	m.tasks[250].Name = "changed.zip"
	m.touchTaskLocked(m.tasks[250])
	m.mu.Unlock()
	if next := m.PageTaskSnapshotsSorted(0, 100, "", "", "id", "asc"); next.OrderVersion == first.OrderVersion {
		t.Fatal("renaming may change a search result or group")
	}
	m.mu.Lock()
	m.removeTaskLocked(250)
	m.mu.Unlock()
	if revision, err := m.WaitTaskChanges(context.Background(), visible.Revision, time.Second); err != nil || revision <= visible.Revision {
		t.Fatal("removal must wake readers")
	}
}
