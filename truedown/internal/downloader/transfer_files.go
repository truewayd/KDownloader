package downloader

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

const (
	transferPending = "pending"
	transferResume  = "resume"
	transferRestart = "restart"
	transferRecheck = "recheck"
)

func retryTransferState(task *Task) string {
	var identity requestIdentity
	if json.Unmarshal([]byte(task.RequestJSON), &identity) == nil && identity.BitTorrent != nil {
		return task.TransferState
	}
	if task.TransferState == transferRestart || requiresCleanHTTPRestart(task.Error) {
		return transferRestart
	}
	if task.TransferState == transferRecheck {
		return transferResume
	}
	return task.TransferState
}

// The caller holds opMu. Persist ownership before aria2 can open an output;
// only an unstarted task may choose another name when a foreign file appears.
func (m *Manager) prepareHTTPOutput(id int64, recheck bool) (*Task, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	task := m.tasks[id]
	if task == nil {
		return nil, fmt.Errorf("task %d not found", id)
	}
	proposed := cloneTask(task)
	if proposed.OutputName == "" {
		name := sanitizeModulePathComponent(task.Name)
		if name == "" {
			name = "download"
		}
		proposed.OutputName = m.resolveOutputNameLocked(task.Folder, name, task.ID)
		if proposed.OutputName == "" {
			return nil, fmt.Errorf("no available output name for %q", name)
		}
	}
	if proposed.TransferState == transferPending && !outputNameAvailable(proposed.Folder, proposed.OutputName) {
		proposed.OutputName = m.resolveOutputNameLocked(task.Folder, task.Name, task.ID)
		if proposed.OutputName == "" {
			return nil, fmt.Errorf("no available output name for %q", task.Name)
		}
	}
	if owner, exists := m.outputNames[outputNameKey(proposed.Folder, proposed.OutputName)]; exists && owner != id {
		return nil, fmt.Errorf("output belongs to task %d; refusing to overwrite it", owner)
	}
	output, control, err := inspectHTTPOutput(proposed)
	if err != nil {
		return nil, err
	}
	// A sparse or preallocated file's length says nothing about which pieces
	// arrived. Without the control file, resume could silently accept holes.
	if !recheck && output != control {
		if err := removePartialFiles(proposed, ""); err != nil {
			return nil, fmt.Errorf("restart incomplete download without valid resume files: %w", err)
		}
	}
	proposed.TransferState = transferResume
	proposed.Revision = m.revision + 1
	proposed.UpdatedAt = task.UpdatedAt
	if err := m.store.Update(proposed); err != nil {
		return nil, fmt.Errorf("persist download output ownership: %w", err)
	}
	m.revision = proposed.Revision
	m.replaceTaskLocked(task, proposed)
	return cloneTask(task), nil
}

func inspectHTTPOutput(task *Task) (bool, bool, error) {
	if task.OutputName == "" || filepath.Base(task.OutputName) != task.OutputName || task.OutputName == "." || task.OutputName == ".." {
		return false, false, fmt.Errorf("invalid HTTP output name")
	}
	var exists [2]bool
	for i, suffix := range []string{"", ".aria2"} {
		info, err := os.Lstat(filepath.Join(task.Folder, task.OutputName+suffix))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return false, false, fmt.Errorf("inspect download output: %w", err)
		}
		if !info.Mode().IsRegular() {
			return false, false, fmt.Errorf("download output must be a regular file: %s", task.OutputName+suffix)
		}
		exists[i] = true
	}
	return exists[0], exists[1], nil
}

func (m *Manager) removeOwnedPartialFiles(task *Task, path string) error {
	name := task.OutputName
	if name == "" && path != "" {
		name = filepath.Base(path)
	}
	m.mu.RLock()
	owner, exists := m.outputNames[outputNameKey(task.Folder, name)]
	m.mu.RUnlock()
	if exists && owner != task.ID {
		return fmt.Errorf("partial output belongs to task %d", owner)
	}
	inspection := *task
	inspection.OutputName = name
	if _, _, err := inspectHTTPOutput(&inspection); err != nil {
		return err
	}
	return removePartialFiles(task, path)
}
