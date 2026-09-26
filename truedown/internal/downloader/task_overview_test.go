package downloader

import "testing"

func TestTaskOverviewFollowsMutationsAndIgnoresViewFilters(t *testing.T) {
	m := &Manager{tasks: map[int64]*Task{}, statusCounts: map[Status]int{}, gids: map[string]int64{}, fingerprints: map[string]int64{}, outputNames: map[string]int64{}}
	for id, task := range map[int64]*Task{
		1: {ID: 1, Name: "movie.mp4", Status: StatusDownloading, DownloadSpeed: 1024},
		2: {ID: 2, Name: "movie-2.mp4", Status: StatusDone},
		3: {ID: 3, Name: "image.png", Status: StatusError},
	} {
		m.tasks[id] = task
		m.orderedIDs = append(m.orderedIDs, id)
		m.statusCounts[task.Status]++
		m.indexTaskOverviewLocked(task)
	}
	page, _ := m.PageTaskSnapshotsFilteredIfChanged(0, 100, StatusError, "image", "id", "asc", "image", "")
	if len(page.Tasks) != 1 || page.Summary.GroupCounts["video"] != 2 || page.Summary.Downloading != 1 || page.Summary.DownloadSpeed != 1024 {
		t.Fatal("filtered page lost global counters", page.Summary)
	}
	page.Summary.GroupCounts["video"] = 900
	if m.summaryLocked().GroupCounts["video"] != 2 {
		t.Fatal("caller can mutate counters")
	}
	m.tasks[1].DownloadSpeed = 2048
	m.touchTaskLocked(m.tasks[1])
	if _, unchanged := m.PageTaskSnapshotsFilteredIfChanged(0, 100, StatusError, "image", "id", "asc", "image", page.Version); unchanged {
		t.Fatal("speed outside the current view did not invalidate its overview")
	}
	m.setStatusLocked(m.tasks[1], StatusPaused)
	m.touchTaskLocked(m.tasks[1])
	if m.summaryLocked().DownloadSpeed != 0 {
		t.Fatal("paused speed remains in total")
	}
	m.tasks[1].OutputName = "renamed.png"
	m.touchTaskLocked(m.tasks[1])
	if m.summaryLocked().GroupCounts["image"] != 2 {
		t.Fatal("observed output name did not reclassify")
	}
	m.removeTaskLocked(1)
	if m.summaryLocked().GroupCounts["image"] != 1 || m.summaryLocked().GroupCounts["video"] != 1 {
		t.Fatal("removal corrupted counts")
	}
}
