package downloader

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"
)

type taskAddRequest struct {
	Link         string
	Name         string
	Folder       string
	Headers      map[string]string
	DownloadPage string
	QueueID      int
	Opts         Aria2Opts
	ModuleID     string
}

type taskAddResult struct {
	Task      *Task
	Duplicate bool
}

type preparedTaskAdd struct {
	request     taskAddRequest
	identity    requestIdentity
	requestJSON string
	fingerprint string
}

// addTasksBatch validates the complete batch first, then creates all fresh
// tasks under one manager lock. Rare duplicate and partial-resume cases fall
// back to AddTask so their existing update semantics stay unchanged.
func (m *Manager) addTasksBatch(requests []taskAddRequest) ([]taskAddResult, error) {
	prepared := make([]preparedTaskAdd, len(requests))
	for index, request := range requests {
		identity := normalizeRequest(
			request.Link, request.Name, request.Folder, m.defaultDir, request.Headers,
			request.DownloadPage, request.QueueID, request.Opts,
		)
		identity.ModuleID = request.ModuleID
		if err := validateRequest(identity); err != nil {
			return nil, err
		}
		encoded, err := json.Marshal(identity)
		if err != nil {
			return nil, err
		}
		digest := sha256.Sum256(encoded)
		prepared[index] = preparedTaskAdd{
			request:     request,
			identity:    identity,
			requestJSON: string(encoded),
			fingerprint: hex.EncodeToString(digest[:]),
		}
	}

	results := make([]taskAddResult, len(prepared))
	fallback := make([]int, 0)
	newIDs := make([]int64, 0, len(prepared))
	now := time.Now()
	m.opMu.Lock()
	m.mu.Lock()
	resumeKeys := make(map[string]struct{})
	for _, task := range m.tasks {
		if task != nil && task.ModuleID != "" && task.Status == StatusError {
			resumeKeys[outputNameKey(task.Folder, task.Name)] = struct{}{}
		}
	}
	for index, item := range prepared {
		name := item.identity.Name
		if name == "" {
			name = displayName(item.identity.Link)
		}
		_, exactDuplicate := m.fingerprints[item.fingerprint]
		_, possibleResume := resumeKeys[outputNameKey(item.identity.Folder, name)]
		if exactDuplicate || possibleResume {
			fallback = append(fallback, index)
			continue
		}
		task := &Task{
			ID:            m.nextID.Add(1),
			Fingerprint:   item.fingerprint,
			RequestJSON:   item.requestJSON,
			Name:          item.identity.Name,
			Link:          item.identity.Link,
			Folder:        item.identity.Folder,
			Headers:       item.identity.Headers,
			DownloadPage:  item.identity.DownloadPage,
			QueueID:       item.identity.QueueID,
			Opts:          item.identity.Opts,
			ModuleID:      item.request.ModuleID,
			DropboxDirect: item.request.ModuleID == DropboxModuleID,
			GID:           m.newGIDLocked(),
			Status:        StatusQueued,
			Progress:      "Waiting for aria2",
			CreatedAt:     now,
			UpdatedAt:     now,
		}
		m.touchTaskLocked(task)
		if task.Name != "" {
			task.OutputName = m.resolveOutputNameLocked(task.Folder, task.Name, task.ID)
		} else {
			task.Name = name
		}
		m.tasks[task.ID] = task
		m.fingerprints[task.Fingerprint] = task.ID
		m.gids[task.GID] = task.ID
		if task.OutputName != "" {
			m.outputNames[outputNameKey(task.Folder, task.OutputName)] = task.ID
		}
		m.statusCounts[task.Status]++
		m.orderedIDs = append(m.orderedIDs, task.ID)
		m.structureRev++
		results[index] = taskAddResult{Task: cloneTask(task)}
		newIDs = append(newIDs, task.ID)
	}
	m.mu.Unlock()
	m.opMu.Unlock()
	m.enqueueAdmissions(newIDs)

	for _, index := range fallback {
		request := prepared[index].request
		task, duplicate, err := m.addTaskWithModule(
			request.Link, request.Name, request.Folder, request.Headers,
			request.DownloadPage, request.QueueID, request.Opts, request.ModuleID,
		)
		if err != nil {
			return nil, err
		}
		results[index] = taskAddResult{Task: task, Duplicate: duplicate}
	}
	return results, nil
}

func (m *Manager) enqueueAdmissions(ids []int64) {
	if len(ids) == 0 {
		return
	}
	m.admissionMu.Lock()
	for _, id := range ids {
		m.admissions = append(m.admissions, admission{id: id})
	}
	m.admissionMu.Unlock()
	select {
	case m.dbWake <- struct{}{}:
	default:
	}
}
