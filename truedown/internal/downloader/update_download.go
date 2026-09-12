package downloader

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

// DownloadUpdate uses ordinary durable tasks, including queue limits and user
// pause/resume/removal. Keep their output available; only the staging copy is
// consumed by the updater. Never delete files behind a retained task's back.
func (m *Manager) DownloadUpdate(ctx context.Context, url, name, directory string, maximum int64, opts Aria2Opts) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if maximum <= 0 {
		return "", fmt.Errorf("invalid update size limit")
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	root, err := os.MkdirTemp(directory, "download-")
	if err != nil {
		return "", err
	}
	task, _, err := m.addTaskWithModule(url, name, root, nil, "", 0, opts, "")
	if err != nil {
		os.Remove(root)
		return "", err
	}
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	interrupt := func(cause error) (string, error) {
		m.opMu.Lock()
		defer m.opMu.Unlock()
		current, exists := m.GetTask(task.ID)
		if !exists || current.Status == StatusDone {
			return "", cause
		}
		if !m.engineExited.Load() && m.lifecycleCtx.Err() == nil && m.rpc != nil {
			if err := m.rpc.forceRemove(current.GID); err != nil && !isGIDNotFound(err) {
				cause = fmt.Errorf("%w; stop update transfer: %v", cause, err)
			}
		}
		// A temporary update endpoint cannot survive process shutdown. Preserve
		// partial bytes as a failed attempt, never an unresumable paused task
		// that would block all subsequent automatic application.
		_ = m.setTask(task.ID, func(current *Task) {
			m.rotateGIDLocked(current)
			m.releaseAriaSlotLocked(current.ID)
			current.Status = StatusError
			current.Error = cause.Error() + "; start the update again from Settings"
			current.Progress = ""
		})
		return "", cause
	}
	for {
		if m.engineExited.Load() {
			return interrupt(fmt.Errorf("download engine exited during update"))
		}
		current, exists := m.GetTask(task.ID)
		if !exists {
			return "", fmt.Errorf("update download was removed")
		}
		if current.TotalLength > maximum || current.CompletedLength > maximum {
			return interrupt(fmt.Errorf("update download exceeds the allowed size"))
		}
		switch current.Status {
		case StatusError:
			return "", fmt.Errorf("update download failed: %s", current.Error)
		case StatusDone:
			return copyUpdateOutput(current, directory, maximum)
		}
		select {
		case <-ctx.Done():
			return interrupt(ctx.Err())
		case <-m.lifecycleCtx.Done():
			return "", fmt.Errorf("download engine stopped during update")
		case <-ticker.C:
		}
	}
}

func copyUpdateOutput(task *Task, directory string, maximum int64) (string, error) {
	if task.OutputName == "" || filepath.Base(task.OutputName) != task.OutputName {
		return "", fmt.Errorf("invalid update output")
	}
	path := filepath.Join(task.Folder, task.OutputName)
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Size() > maximum {
		return "", fmt.Errorf("invalid update file")
	}
	source, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer source.Close()
	file, err := os.CreateTemp(directory, ".download-*.tmp")
	if err != nil {
		return "", err
	}
	ok := false
	defer func() {
		file.Close()
		if !ok {
			os.Remove(file.Name())
		}
	}()
	size, err := io.Copy(file, io.LimitReader(source, maximum+1))
	if err != nil {
		return "", err
	}
	if size > maximum || size != info.Size() {
		return "", fmt.Errorf("update file changed or exceeds its size limit")
	}
	if err := file.Sync(); err != nil {
		return "", err
	}
	if err := file.Close(); err != nil {
		return "", err
	}
	ok = true
	return file.Name(), nil
}
