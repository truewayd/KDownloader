package downloader

import (
	"context"
	"fmt"
	"time"
)

// A closed generation wakes all readers without buffering one event per task.
// The caller owns m.mu; readers recheck the revision under the same lock.
func (m *Manager) notifyTaskChangeLocked() {
	if m.listChanged != nil {
		close(m.listChanged)
		m.listChanged = nil
	}
}

func (m *Manager) WaitTaskChanges(ctx context.Context, after int64, wait time.Duration) (int64, error) {
	m.mu.Lock()
	if m.revision != after {
		revision := m.revision
		m.mu.Unlock()
		return revision, nil
	}
	if m.listChanged == nil {
		m.listChanged = make(chan struct{})
	}
	changed := m.listChanged
	m.mu.Unlock()
	timer := time.NewTimer(min(max(wait, 0), 10*time.Second))
	defer timer.Stop()
	select {
	case <-changed:
	case <-timer.C:
	case <-ctx.Done():
		return 0, ctx.Err()
	case <-m.done:
		return 0, context.Canceled
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.revision, nil
}

// Independent row and order versions allow overview-only replies and cache reuse
// across progress updates. Progress ordering itself changes on every revision.
func (m *Manager) versionTaskPageLocked(page TaskPage, sortField string) TaskPage {
	page.Epoch = m.listEpoch
	order := m.listRevision
	if sortField == "progress" {
		order = m.revision
	}
	page.OrderVersion = fmt.Sprintf("%s-%x-%x-%x", m.listEpoch, m.structureRev, order, m.fileGroups.Revision)
	version := uint64(14695981039346656037)
	for _, task := range page.Tasks {
		version = (version ^ uint64(task.ID)) * 1099511628211
		version = (version ^ uint64(task.Revision)) * 1099511628211
	}
	page.RowsVersion = fmt.Sprintf("%s-%x", page.OrderVersion, version)
	return page
}
