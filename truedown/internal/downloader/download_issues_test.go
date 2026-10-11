package downloader

import "testing"

func TestDownloadIssuesCountOnlyNewErrorTransitions(t *testing.T) {
	m := &Manager{statusCounts: map[Status]int{StatusQueued: 1}, listEpoch: "epoch"}
	task := &Task{Status: StatusQueued, ModuleID: GoogleDriveModuleID}
	m.setStatusLocked(task, StatusError)
	m.setStatusLocked(task, StatusError)
	if got := m.DownloadIssues(); got.GoogleDrive != 1 || got.Downloads != 0 || got.Epoch != "epoch" {
		t.Fatalf("issues: %#v", got)
	}
	m.setStatusLocked(task, StatusQueued)
	m.setStatusLocked(task, StatusError)
	m.recordModuleIssue(DropboxModuleID)
	if got := m.DownloadIssues(); got.GoogleDrive != 2 || got.Dropbox != 1 {
		t.Fatalf("retry: %#v", got)
	}
}
