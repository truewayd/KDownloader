package downloader

import (
	"fmt"
	"os"
	"path/filepath"
)

// OpenDownloadDirectory opens TrueDown's default download directory on the host.
func (m *Manager) OpenDownloadDirectory() error {
	folder, err := filepath.Abs(m.defaultDir)
	if err != nil {
		return fmt.Errorf("resolve download directory: %w", err)
	}
	if err := os.MkdirAll(folder, 0755); err != nil {
		return fmt.Errorf("create download directory: %w", err)
	}
	if m.openPath == nil {
		return fmt.Errorf("system path opener is unavailable")
	}
	if err := m.openPath(folder); err != nil {
		return fmt.Errorf("open download directory: %w", err)
	}
	return nil
}

// OpenTaskDirectory opens the task's configured download directory.
func (m *Manager) OpenTaskDirectory(id int64) error {
	task, ok := m.GetTask(id)
	if !ok {
		return &ValidationError{Message: fmt.Sprintf("task %d not found", id)}
	}
	folder, err := filepath.Abs(task.Folder)
	if err != nil {
		return fmt.Errorf("resolve task directory: %w", err)
	}
	if err := os.MkdirAll(folder, 0755); err != nil {
		return fmt.Errorf("create task directory: %w", err)
	}
	if m.openPath == nil {
		return fmt.Errorf("system path opener is unavailable")
	}
	if err := m.openPath(folder); err != nil {
		return fmt.Errorf("open task directory: %w", err)
	}
	return nil
}

// OpenTaskFile opens a completed task's exact output file on the host. The
// client supplies only a task ID and cannot choose an arbitrary local path.
func (m *Manager) OpenTaskFile(id int64) error {
	task, ok := m.GetTask(id)
	if !ok {
		return &ValidationError{Message: fmt.Sprintf("task %d not found", id)}
	}
	if task.Status != StatusDone || task.OutputName == "" {
		return &ValidationError{Message: "task file is not available until the download completes"}
	}
	folder, err := filepath.Abs(task.Folder)
	if err != nil {
		return fmt.Errorf("resolve task directory: %w", err)
	}
	target, err := filepath.Abs(filepath.Join(folder, task.OutputName))
	if err != nil {
		return fmt.Errorf("resolve task file: %w", err)
	}
	relative, err := filepath.Rel(folder, target)
	if err != nil || filepath.IsAbs(relative) || filepath.Dir(relative) != "." || !samePathName(relative, task.OutputName) {
		return &ValidationError{Message: "task file is outside its download directory"}
	}
	info, err := os.Lstat(target)
	if os.IsNotExist(err) {
		return &ValidationError{Message: "downloaded file no longer exists"}
	}
	if err != nil {
		return fmt.Errorf("inspect task file: %w", err)
	}
	if !info.Mode().IsRegular() {
		return &ValidationError{Message: "task output is not a regular file"}
	}
	if m.openPath == nil {
		return fmt.Errorf("system path opener is unavailable")
	}
	if err := m.openPath(target); err != nil {
		return fmt.Errorf("open task file: %w", err)
	}
	return nil
}
