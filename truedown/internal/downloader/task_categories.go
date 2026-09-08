package downloader

import (
	"path"
	"sort"
	"strings"
)

func (m *Manager) classifyTask(task *Task) string {
	name := task.OutputName
	if name == "" {
		name = task.Name
	}
	if name == "" {
		name = displayName(task.Link)
	}
	name = strings.ToLower(path.Base(strings.ReplaceAll(name, "\\", "/")))
	index := m.fileGroupIndex
	if index == nil {
		index = defaultFileGroupIndex
	}
	for offset := strings.IndexByte(name, '.'); offset >= 0; {
		if category := index[name[offset:]]; category != "" {
			return category
		}
		next := strings.IndexByte(name[offset+1:], '.')
		if next < 0 {
			break
		}
		offset += next + 1
	}
	return "other"
}

// Filtering precedes sorting and pagination, including tasks outside the visible page.
func (m *Manager) categoryPageLocked(offset, limit int, status Status, search, field, order, category, version string) TaskPage {
	ids := make([]int64, 0)
	for _, id := range m.orderedIDs {
		task := m.tasks[id]
		if taskMatchesPage(task, status, search) && m.classifyTask(task) == category {
			ids = append(ids, id)
		}
	}
	sort.SliceStable(ids, func(i, j int) bool {
		comparison := compareTasksForPage(m.tasks[ids[i]], m.tasks[ids[j]], field)
		if comparison == 0 {
			comparison = compareInt64(ids[i], ids[j])
		}
		if order == "desc" || field == "" {
			return comparison > 0
		}
		return comparison < 0
	})
	page := TaskPage{Groups: m.fileGroupsLocked(), Tasks: make([]TaskSnapshot, 0, min(limit, len(ids))), Summary: m.summaryLocked(), Offset: offset, Limit: limit, Total: len(ids), Revision: m.revision, Version: version}
	for i := offset; i < len(ids) && len(page.Tasks) < limit; i++ {
		page.Tasks = append(page.Tasks, m.snapshotTask(m.tasks[ids[i]]))
	}
	return page
}
