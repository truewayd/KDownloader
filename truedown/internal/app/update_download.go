package app

import (
	"context"
	"fmt"

	"truedown/internal/downloader"
	"truedown/internal/systemupdate"
)

func (host *managerHost) downloadUpdate(ctx context.Context, url, name, directory string, maximum int64) (string, error) {
	// Keep this manager's store alive until completion/cancellation is persisted.
	// Engine exit is observed by DownloadUpdate before recovery acquires this gate.
	host.switchMu.Lock()
	defer host.switchMu.Unlock()
	if err := ctx.Err(); err != nil {
		return "", err
	}
	host.mu.RLock()
	current := host.current
	host.mu.RUnlock()
	if current == nil {
		return "", fmt.Errorf("download engine is unavailable")
	}
	return current.manager.DownloadUpdate(ctx, url, name, directory, maximum, downloader.Aria2Opts{
		Connections: 4, MaxTries: 3, RetryWait: 3, ProxyMode: "none",
	})
}

// A queued download may stay paused longer than an HTTP or native IPC deadline.
// Admission is acknowledged immediately; the process owns the operation lifetime.
func (controller *engineController) StartUpdate(operation string) (systemupdate.Snapshot, error) {
	snapshot := controller.updates.Snapshot()
	if operation != "truedown" && operation != "next-engine" {
		return snapshot, fmt.Errorf("invalid update operation")
	}
	if operation == "truedown" && !snapshot.TrueDown.Supported {
		return snapshot, fmt.Errorf("program updates are unavailable")
	}
	if operation == "next-engine" && !snapshot.Engine.AutoUpdateSupported {
		return snapshot, fmt.Errorf("NEXT installation is unavailable")
	}
	controller.mu.Lock()
	if err := controller.updateContext.Err(); err != nil {
		controller.mu.Unlock()
		return snapshot, err
	}
	if controller.requestedUpdate != "" || controller.phase != "" || snapshot.Busy != "" {
		controller.mu.Unlock()
		return snapshot, fmt.Errorf("an update operation is already running")
	}
	controller.requestedUpdate = operation
	controller.updateWorkers.Add(1)
	controller.lastError = ""
	controller.mu.Unlock()
	snapshot.Busy, snapshot.Error = operation, ""
	go func() {
		defer controller.updateWorkers.Done()
		var err error
		if operation == "truedown" {
			_, err = controller.UpdateTrueDown(controller.updateContext)
		} else {
			_, err = controller.InstallNext(controller.updateContext)
		}
		if err != nil {
			controller.updates.RecordEngineError(err)
		}
		controller.mu.Lock()
		controller.requestedUpdate = ""
		controller.mu.Unlock()
	}()
	return snapshot, nil
}

func (controller *engineController) waitUpdates() {
	// Cancellation precedes this barrier, so no new worker can be admitted.
	controller.mu.Lock()
	controller.mu.Unlock()
	controller.updateWorkers.Wait()
}
