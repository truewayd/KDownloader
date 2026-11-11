package downloader

import (
	"fmt"
	"strings"
)

// Selection is a fixed set captured under the same lock as list filtering.
// It deliberately carries no progress, file paths or other row presentation.
type TaskSelectionEntry struct {
	ID             int64  `json:"id"`
	Status         Status `json:"status"`
	Link           string `json:"link"`
	UpdateDownload bool   `json:"updateDownload"`
}

func (m *Manager) SelectTasks(status Status, search, category string) ([]TaskSelectionEntry, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	search = strings.ToLower(strings.TrimSpace(search))
	entries := make([]TaskSelectionEntry, 0)
	bytes := 0
	for _, id := range m.orderedIDs {
		task := m.tasks[id]
		if !taskMatchesPage(task, status, search) || (category != "" && m.taskCategoryLocked(task) != category) {
			continue
		}
		bytes += len(task.Link)*6 + 128
		if len(entries) >= 50000 || bytes > 6<<20 {
			return nil, fmt.Errorf("selection is too large; narrow the task filters")
		}
		entries = append(entries, TaskSelectionEntry{ID: id, Status: task.Status, Link: task.Link, UpdateDownload: task.UpdateDownload})
	}
	return entries, nil
}
