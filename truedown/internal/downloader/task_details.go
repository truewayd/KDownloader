package downloader

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

var ErrTaskNotFound = errors.New("task not found")
var ErrTaskSettingsConflict = errors.New("task changed; reload its settings before saving")

// Only bounded numeric preferences cross the task detail boundary.
type TaskSettings struct {
	Connections int `json:"connections"`
	MaxSpeedBps int `json:"maxSpeedBps"`
	MaxTries    int `json:"maxTries"`
	RetryWait   int `json:"retryWait"`
}

type TaskDetails struct {
	TaskSnapshot
	Groups           FileGroupsSnapshot `json:"groups"`
	Settings         TaskSettings       `json:"settings"`
	SettingsRevision string             `json:"settingsRevision"`
}

func taskSettings(task *Task) TaskSettings {
	values := TaskSettings{task.Opts.Connections, task.Opts.MaxSpeedBps, task.Opts.MaxTries, task.Opts.RetryWait}
	if values.Connections <= 0 {
		values.Connections = 16
	}
	if values.MaxTries <= 0 {
		values.MaxTries = 5
	}
	if values.RetryWait <= 0 {
		values.RetryWait = 3
	}
	options := ariaOptions(task, false)
	for name, target := range map[string]*int{"max-connection-per-server": &values.Connections, "max-download-limit": &values.MaxSpeedBps, "max-tries": &values.MaxTries, "retry-wait": &values.RetryWait} {
		raw, _ := options[name].(string)
		multiplier := int64(1)
		if name == "max-download-limit" && len(raw) > 0 {
			switch strings.ToUpper(raw[len(raw)-1:]) {
			case "K":
				multiplier = 1024
			case "M":
				multiplier = 1024 * 1024
			case "G":
				multiplier = 1024 * 1024 * 1024
			}
			if multiplier != 1 {
				raw = raw[:len(raw)-1]
			}
		}
		if value, err := strconv.ParseInt(raw, 10, 64); err == nil && value >= 0 && value <= (1<<50)/multiplier {
			*target = int(value * multiplier)
		}
	}
	return values
}

func removeTaskOptionOverrides(args []string, changes map[string]string) []string {
	result := make([]string, 0, len(args))
	for _, raw := range args {
		name := strings.ToLower(strings.SplitN(strings.TrimSpace(strings.TrimPrefix(raw, "--")), "=", 2)[0])
		if _, replaced := changes[name]; !replaced {
			result = append(result, raw)
		}
	}
	return result
}

func (m *Manager) taskDetails(task *Task) TaskDetails {
	return TaskDetails{m.snapshotTask(task), m.fileGroupsLocked(), taskSettings(task), task.Fingerprint}
}

func (m *Manager) TaskDetails(id int64) (TaskDetails, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if task := m.tasks[id]; task != nil {
		return m.taskDetails(task), nil
	}
	return TaskDetails{}, ErrTaskNotFound
}

type taskOptionsRPC interface {
	changeOptions(string, map[string]string) error
}

func taskOptionChanges(before, after TaskSettings) map[string]string {
	options := map[string]string{}
	if before.Connections != after.Connections {
		options["split"] = strconv.Itoa(after.Connections)
		options["max-connection-per-server"] = strconv.Itoa(after.Connections)
	}
	if before.MaxSpeedBps != after.MaxSpeedBps {
		options["max-download-limit"] = strconv.Itoa(after.MaxSpeedBps)
	}
	if before.MaxTries != after.MaxTries {
		options["max-tries"] = strconv.Itoa(after.MaxTries)
	}
	if before.RetryWait != after.RetryWait {
		options["retry-wait"] = strconv.Itoa(after.RetryWait)
	}
	return options
}

func (m *Manager) SetTaskSettings(id int64, revision string, values TaskSettings) (TaskDetails, error) {
	if values.Connections < 1 || values.Connections > 64 || values.MaxSpeedBps < 0 || int64(values.MaxSpeedBps) > 1<<50 || values.MaxTries < 1 || values.MaxTries > 100 || values.RetryWait < 1 || values.RetryWait > 3600 {
		return TaskDetails{}, &ValidationError{Message: "task settings are outside the allowed range"}
	}
	m.opMu.Lock()
	defer m.opMu.Unlock()
	m.mu.Lock()
	defer m.mu.Unlock()
	task := m.tasks[id]
	if task == nil {
		return TaskDetails{}, ErrTaskNotFound
	}
	if revision == "" || revision != task.Fingerprint {
		return TaskDetails{}, ErrTaskSettingsConflict
	}
	if task.Status == StatusDone {
		return TaskDetails{}, &ValidationError{Message: "completed task settings are read-only"}
	}
	before := taskSettings(task)
	changes := taskOptionChanges(before, values)
	if len(changes) == 0 {
		return m.taskDetails(task), nil
	}
	if task.Status == StatusDownloading && (before.Connections != values.Connections || before.MaxTries != values.MaxTries || before.RetryWait != values.RetryWait) {
		return TaskDetails{}, &ValidationError{Message: "pause the task before changing connections or retry settings"}
	}
	if m.engineExited.Load() {
		return TaskDetails{}, fmt.Errorf("download engine is not running")
	}
	// A just-created task may still be waiting for its initial SQLite insert.
	m.store.mu.Lock()
	rows, err := m.store.db.Query("SELECT id FROM download_records WHERE id=?", id)
	var persisted bool
	if err == nil {
		persisted, err = rows.Next()
		rows.Close()
	}
	m.store.mu.Unlock()
	if err != nil {
		return TaskDetails{}, err
	}
	if !persisted {
		return TaskDetails{}, ErrTaskSettingsConflict
	}
	var identity requestIdentity
	if err := json.Unmarshal([]byte(task.RequestJSON), &identity); err != nil {
		return TaskDetails{}, err
	}
	identity.Opts.Connections, identity.Opts.MaxSpeedBps = values.Connections, values.MaxSpeedBps
	identity.Opts.MaxTries, identity.Opts.RetryWait = values.MaxTries, values.RetryWait
	// Explicit per-task edits take precedence over the same extra option.
	identity.Opts.ExtraArgs = removeTaskOptionOverrides(identity.Opts.ExtraArgs, changes)
	data, err := json.Marshal(identity)
	if err != nil {
		return TaskDetails{}, err
	}
	digest := sha256.Sum256(data)
	fingerprint := hex.EncodeToString(digest[:])
	if owner, exists := m.fingerprints[fingerprint]; exists && owner != id {
		return TaskDetails{}, ErrTaskSettingsConflict
	}
	proposed := cloneTask(task)
	proposed.Opts, proposed.RequestJSON, proposed.Fingerprint = identity.Opts, string(data), fingerprint
	proposed.Revision, proposed.UpdatedAt = m.revision+1, time.Now()
	var rpc taskOptionsRPC
	if m.ariaAdmitted[id] {
		var ok bool
		rpc, ok = m.rpc.(taskOptionsRPC)
		if !ok {
			return TaskDetails{}, fmt.Errorf("engine does not support task settings")
		}
		if err := rpc.changeOptions(task.GID, changes); err != nil {
			return TaskDetails{}, err
		}
	}
	if err := m.store.UpdateRequest(proposed); err != nil {
		if rpc != nil {
			if rollbackErr := rpc.changeOptions(task.GID, taskOptionChanges(values, before)); rollbackErr != nil {
				return TaskDetails{}, fmt.Errorf("save failed: %w; engine rollback failed: %v", err, rollbackErr)
			}
		}
		return TaskDetails{}, err
	}
	m.revision = proposed.Revision
	m.replaceTaskLocked(task, proposed)
	return m.taskDetails(task), nil
}
