package downloader

// Only counters cross the notification boundary: no URLs, credentials or raw errors.
type DownloadIssues struct {
	Epoch       string `json:"epoch"`
	Downloads   uint64 `json:"downloads"`
	Dropbox     uint64 `json:"dropbox"`
	GoogleDrive uint64 `json:"googleDrive"`
}

func (m *Manager) DownloadIssues() DownloadIssues {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := m.downloadIssues
	result.Epoch = m.listEpoch
	return result
}

func (m *Manager) recordModuleIssue(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.recordIssueLocked(id)
}

func (m *Manager) recordIssueLocked(module string) {
	switch module {
	case DropboxModuleID:
		m.downloadIssues.Dropbox++
	case GoogleDriveModuleID:
		m.downloadIssues.GoogleDrive++
	default:
		m.downloadIssues.Downloads++
	}
}

func (m *Manager) recordStatusIssueLocked(task *Task, old Status) {
	if old != StatusError && task.Status == StatusError {
		m.recordIssueLocked(task.ModuleID)
	}
}
