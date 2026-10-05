package downloader

import (
	"path"
	"strings"
)

type taskListKey struct {
	name, outputName, link, category string
}

// Update overview counters at mutation boundaries, not by scanning on each read.
func (m *Manager) indexTaskOverviewLocked(task *Task) {
	if m.groupCounts == nil {
		m.groupCounts = make(map[string]int)
	}
	category := m.classifyTask(task)
	key := taskListKey{task.Name, task.OutputName, task.Link, category}
	if key != task.listKey {
		m.listRevision++
		task.listKey = key
	}
	if category != task.overviewCategory {
		if task.overviewCategory != "" {
			m.groupCounts[task.overviewCategory]--
			if m.groupCounts[task.overviewCategory] == 0 {
				delete(m.groupCounts, task.overviewCategory)
			}
		}
		m.groupCounts[category]++
		task.overviewCategory = category
	}
	speed := int64(0)
	if task.Status == StatusDownloading {
		speed = max(0, task.DownloadSpeed)
	}
	m.downloadSpeed += speed - task.overviewSpeed
	task.overviewSpeed = speed
}

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
	page := TaskPage{Groups: m.fileGroupsLocked(), Tasks: make([]TaskSnapshot, 0, limit), Summary: m.summaryLocked(), Offset: offset, Limit: limit, Revision: m.revision, Version: version}
	countKnown := status == "" && search == "" && m.groupCounts != nil
	if countKnown {
		page.Total = m.groupCounts[category]
		if offset >= page.Total {
			return page
		}
	}
	matched := 0
	appendMatch := func(task *Task) {
		if matched >= offset && len(page.Tasks) < limit {
			page.Tasks = append(page.Tasks, m.snapshotTask(task))
		}
		matched++
		if !countKnown {
			page.Total++
		}
	}
	if field == "status" {
		// Match global status/ID ordering without allocating and sorting the group.
		ranks := []int{0, 1, 2, 3, 4, 5}
		if status != "" {
			ranks = []int{taskStatusSortRank(status)}
		} else if order == "desc" {
			ranks = []int{5, 4, 3, 2, 1, 0}
		}
		for _, rank := range ranks {
			if ranked, known := taskStatusForSortRank(rank); known && m.statusCounts[ranked] == 0 {
				continue
			}
			start, end, step := 0, len(m.orderedIDs), 1
			if order == "desc" {
				start, end, step = len(m.orderedIDs)-1, -1, -1
			}
			for i := start; i != end; i += step {
				task := m.tasks[m.orderedIDs[i]]
				if !taskMatchesPage(task, status, search) || taskStatusSortRank(task.Status) != rank || m.taskCategoryLocked(task) != category {
					continue
				}
				appendMatch(task)
				if countKnown && len(page.Tasks) == limit {
					return page
				}
			}
		}
		return page
	}
	if field == "" || field == "id" {
		// Reuse the ordered index and retain only this page, even for large groups.
		start, end, step := 0, len(m.orderedIDs), 1
		if field == "" || order == "desc" {
			start, end, step = len(m.orderedIDs)-1, -1, -1
		}
		for i := start; i != end; i += step {
			task := m.tasks[m.orderedIDs[i]]
			if !taskMatchesPage(task, status, search) || m.taskCategoryLocked(task) != category {
				continue
			}
			appendMatch(task)
			if countKnown && len(page.Tasks) == limit {
				return page
			}
		}
		return page
	}
	ids := make([]int64, 0)
	for _, id := range m.orderedIDs {
		task := m.tasks[id]
		if taskMatchesPage(task, status, search) && m.taskCategoryLocked(task) == category {
			ids = append(ids, id)
		}
	}
	m.sortTaskIDsForPage(ids, field, order)
	page.Total = len(ids)
	for i := offset; i < len(ids) && len(page.Tasks) < limit; i++ {
		page.Tasks = append(page.Tasks, m.snapshotTask(m.tasks[ids[i]]))
	}
	return page
}

func (m *Manager) taskCategoryLocked(task *Task) string {
	if task.overviewCategory != "" {
		return task.overviewCategory
	}
	return m.classifyTask(task)
}
