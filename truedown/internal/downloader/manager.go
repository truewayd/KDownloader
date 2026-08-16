package downloader

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

type Status string

const (
	StatusQueued      Status = "queued"
	StatusDownloading Status = "downloading"
	StatusPaused      Status = "paused"
	StatusDone        Status = "done"
	StatusError       Status = "error"
	ariaBacklogLimit         = 256
)

// Aria2Opts holds user-tunable aria2 download parameters.
type Aria2Opts struct {
	Connections int      `json:"connections"`
	MaxSpeedBps int      `json:"maxSpeedBps"`
	MaxTries    int      `json:"maxTries"`
	RetryWait   int      `json:"retryWait"`
	ExtraArgs   []string `json:"extraArgs"`
}

type Task struct {
	ID           int64             `json:"id"`
	Name         string            `json:"name"`
	Link         string            `json:"link"`
	Folder       string            `json:"folder"`
	QueueID      int               `json:"queueId"`
	Headers      map[string]string `json:"headers"`
	DownloadPage string            `json:"downloadPage,omitempty"`
	Opts         Aria2Opts         `json:"opts"`
	OutputName   string            `json:"outputName,omitempty"`
	GID          string            `json:"gid"`
	Status       Status            `json:"status"`
	Progress     string            `json:"progress"`
	Error        string            `json:"error,omitempty"`
	CreatedAt    time.Time         `json:"createdAt"`
	UpdatedAt    time.Time         `json:"updatedAt"`
	Revision     int64             `json:"-"`

	Fingerprint string `json:"-"`
	RequestJSON string `json:"-"`
}

// TaskSnapshot contains only fields needed by the web UI. Request headers and
// aria2 options can contain credentials and must not be exposed by the API.
type TaskSnapshot struct {
	ID         int64     `json:"id"`
	Name       string    `json:"name"`
	Link       string    `json:"link"`
	Folder     string    `json:"folder"`
	OutputName string    `json:"outputName,omitempty"`
	Status     Status    `json:"status"`
	Progress   string    `json:"progress"`
	Error      string    `json:"error,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

type TaskSummary struct {
	Total       int `json:"total"`
	Queued      int `json:"queued"`
	Downloading int `json:"downloading"`
	Paused      int `json:"paused"`
	Done        int `json:"done"`
	Error       int `json:"error"`
}

type TaskPage struct {
	Tasks    []TaskSnapshot `json:"tasks"`
	Summary  TaskSummary    `json:"summary"`
	Offset   int            `json:"offset"`
	Limit    int            `json:"limit"`
	Total    int            `json:"total"`
	Revision int64          `json:"revision"`
	Version  string         `json:"-"`
}

type TaskOperationFailure struct {
	ID    int64  `json:"id"`
	Error string `json:"error"`
}

type TaskOperationResult struct {
	Succeeded []int64                `json:"succeeded"`
	Failed    []TaskOperationFailure `json:"failed"`
	Remaining int                    `json:"remaining,omitempty"`
}

type ValidationError struct{ Message string }

func (e *ValidationError) Error() string { return e.Message }

func IsValidationError(err error) bool {
	_, ok := err.(*ValidationError)
	return ok
}

type requestIdentity struct {
	Link         string            `json:"link"`
	Name         string            `json:"name"`
	Folder       string            `json:"folder"`
	QueueID      int               `json:"queueId"`
	Headers      map[string]string `json:"headers"`
	DownloadPage string            `json:"downloadPage"`
	Opts         Aria2Opts         `json:"opts"`
}

type submission struct {
	id        int64
	recheck   bool
	removeGID string
}

type admission struct {
	id int64
}

type ariaRPC interface {
	ready() error
	addURI(*Task, map[string]any) error
	pause(string) error
	unpause(string) error
	forceRemove(string) error
	removeResult(string) error
	purgeResults() error
	shutdown() error
	statuses() ([]ariaStatus, error)
}

type Manager struct {
	aria2Path  string
	defaultDir string
	store      *recordStore

	mu           sync.RWMutex
	tasks        map[int64]*Task
	fingerprints map[string]int64
	gids         map[string]int64
	outputNames  map[string]int64
	orderedIDs   []int64
	statusCounts map[Status]int
	revision     int64
	structureRev int64
	ariaAdmitted map[int64]bool
	ariaSlots    chan struct{}
	opMu         sync.Mutex
	nextID       atomic.Int64

	admissionMu sync.Mutex
	admissions  []admission
	dbWake      chan struct{}

	pendingMu sync.Mutex
	pending   []submission
	wake      chan struct{}
	done      chan struct{}
	wg        sync.WaitGroup
	stopOnce  sync.Once

	rpc     ariaRPC
	cmd     *exec.Cmd
	cmdDone chan error
	logFile *os.File
}

func NewManager(aria2Path, defaultDir, databasePath string) (*Manager, error) {
	store, err := openRecordStore(databasePath)
	if err != nil {
		return nil, err
	}
	tasks, err := store.LoadAll()
	if err != nil {
		store.Close()
		return nil, fmt.Errorf("load download records: %w", err)
	}
	m := &Manager{
		aria2Path:    aria2Path,
		defaultDir:   defaultDir,
		store:        store,
		tasks:        make(map[int64]*Task, len(tasks)),
		fingerprints: make(map[string]int64, len(tasks)),
		gids:         make(map[string]int64, len(tasks)),
		outputNames:  make(map[string]int64, len(tasks)),
		orderedIDs:   make([]int64, 0, len(tasks)),
		statusCounts: make(map[Status]int, 5),
		ariaAdmitted: make(map[int64]bool, ariaBacklogLimit),
		ariaSlots:    make(chan struct{}, ariaBacklogLimit),
		wake:         make(chan struct{}, 1),
		dbWake:       make(chan struct{}, 1),
		done:         make(chan struct{}),
	}
	var maxID int64
	for _, task := range tasks {
		if task.Revision <= 0 {
			task.Revision = task.ID
		}
		m.tasks[task.ID] = task
		m.fingerprints[task.Fingerprint] = task.ID
		m.gids[task.GID] = task.ID
		if task.OutputName != "" {
			m.outputNames[outputNameKey(task.Folder, task.OutputName)] = task.ID
		}
		m.orderedIDs = append(m.orderedIDs, task.ID)
		m.statusCounts[task.Status]++
		if task.Revision > m.revision {
			m.revision = task.Revision
		}
		if task.ID > maxID {
			maxID = task.ID
		}
	}
	sort.Slice(m.orderedIDs, func(i, j int) bool { return m.orderedIDs[i] < m.orderedIDs[j] })
	m.structureRev = m.revision
	m.nextID.Store(maxID)
	m.wg.Add(1)
	go m.persistenceWriter()
	return m, nil
}

func (m *Manager) Start() error {
	if err := os.MkdirAll(m.defaultDir, 0755); err != nil {
		return fmt.Errorf("create default download directory: %w", err)
	}
	if err := m.startAria2(); err != nil {
		return err
	}
	m.wg.Add(2)
	go m.dispatcher()
	go m.poller()

	var restored []*Task
	var submissions []submission
	m.mu.Lock()
	for _, task := range m.tasks {
		switch task.Status {
		case StatusQueued, StatusDownloading:
			m.setStatusLocked(task, StatusQueued)
			task.Progress = "Waiting for aria2 to restore download progress"
			m.touchTaskLocked(task)
			restored = append(restored, cloneTask(task))
			submissions = append(submissions, submission{id: task.ID})
		case StatusPaused:
			submissions = append(submissions, submission{id: task.ID})
		}
	}
	m.mu.Unlock()
	if err := m.store.UpdateBatch(restored); err != nil {
		log.Printf("persist %d restored tasks: %v", len(restored), err)
	}
	for _, item := range submissions {
		m.enqueue(item)
	}
	return nil
}

func (m *Manager) Stop() {
	m.stopOnce.Do(func() {
		close(m.done)
		m.wg.Wait()
		if m.rpc != nil {
			_ = m.rpc.shutdown()
		}
		if m.cmdDone != nil {
			select {
			case <-m.cmdDone:
			case <-time.After(4 * time.Second):
				if m.cmd != nil && m.cmd.Process != nil {
					_ = m.cmd.Process.Kill()
				}
			}
		}
		if m.logFile != nil {
			_ = m.logFile.Close()
		}
		if m.store != nil {
			_ = m.store.Close()
		}
	})
}

// AddTask records the request and returns immediately. Persistence and aria2
// admission run asynchronously behind a bounded aria2 backlog window.
func (m *Manager) AddTask(link, name, folder string, headers map[string]string, downloadPage string, queueID int, opts Aria2Opts) (*Task, bool, error) {
	m.opMu.Lock()
	defer m.opMu.Unlock()

	identity := normalizeRequest(link, name, folder, m.defaultDir, headers, downloadPage, queueID, opts)
	if err := validateRequest(identity); err != nil {
		return nil, false, err
	}
	requestJSON, err := json.Marshal(identity)
	if err != nil {
		return nil, false, err
	}
	fingerprintBytes := sha256.Sum256(requestJSON)
	fingerprint := hex.EncodeToString(fingerprintBytes[:])

	m.mu.Lock()
	if id, ok := m.fingerprints[fingerprint]; ok {
		task := m.tasks[id]
		shouldRecheck := task.Status == StatusDone || task.Status == StatusError
		removeGID := ""
		if shouldRecheck {
			removeGID = m.rotateGIDLocked(task)
			m.setStatusLocked(task, StatusQueued)
			task.Error = ""
			task.Progress = "Checking whether the remote content has changed"
			m.touchTaskLocked(task)
		}
		result := cloneTask(task)
		m.mu.Unlock()
		if shouldRecheck {
			if err := m.store.Update(result); err != nil {
				return nil, true, err
			}
			m.enqueue(submission{id: id, recheck: true, removeGID: removeGID})
		}
		return result, true, nil
	}

	now := time.Now()
	task := &Task{
		ID:           m.nextID.Add(1),
		Fingerprint:  fingerprint,
		RequestJSON:  string(requestJSON),
		Name:         identity.Name,
		Link:         identity.Link,
		Folder:       identity.Folder,
		Headers:      identity.Headers,
		DownloadPage: identity.DownloadPage,
		QueueID:      identity.QueueID,
		Opts:         identity.Opts,
		GID:          m.newGIDLocked(),
		Status:       StatusQueued,
		Progress:     "Waiting for aria2",
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	m.touchTaskLocked(task)
	if task.Name != "" {
		task.OutputName = m.resolveOutputNameLocked(task.Folder, task.Name, task.ID)
	} else {
		task.Name = displayName(task.Link)
	}
	m.tasks[task.ID] = task
	m.fingerprints[fingerprint] = task.ID
	m.gids[task.GID] = task.ID
	if task.OutputName != "" {
		m.outputNames[outputNameKey(task.Folder, task.OutputName)] = task.ID
	}
	m.statusCounts[task.Status]++
	m.orderedIDs = append(m.orderedIDs, task.ID)
	m.structureRev++
	result := cloneTask(task)
	m.mu.Unlock()

	m.enqueueAdmission(admission{id: task.ID})
	return result, false, nil
}

func (m *Manager) GetTask(id int64) (*Task, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	task, ok := m.tasks[id]
	if !ok {
		return nil, false
	}
	return cloneTask(task), true
}

func (m *Manager) ListTasks() []*Task {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make([]*Task, 0, len(m.tasks))
	for _, task := range m.tasks {
		result = append(result, cloneTask(task))
	}
	return result
}

// PageTaskSnapshots returns a bounded newest-first view without sorting or
// cloning the full task map. A status filter of "" includes every task.
func (m *Manager) PageTaskSnapshots(offset, limit int, status Status) TaskPage {
	if offset < 0 {
		offset = 0
	}
	if limit < 1 {
		limit = 100
	}
	m.mu.RLock()
	defer m.mu.RUnlock()

	total := len(m.tasks)
	if status != "" {
		total = m.statusCounts[status]
	}
	page := TaskPage{
		Tasks:    make([]TaskSnapshot, 0, min(limit, max(0, total-offset))),
		Summary:  m.summaryLocked(),
		Offset:   offset,
		Limit:    limit,
		Total:    total,
		Revision: m.revision,
	}
	version := uint64(m.structureRev) ^ uint64(offset+1)*1099511628211 ^ uint64(limit)
	skipped := 0
	for index := len(m.orderedIDs) - 1; index >= 0 && len(page.Tasks) < limit; index-- {
		task := m.tasks[m.orderedIDs[index]]
		if task == nil || (status != "" && task.Status != status) {
			continue
		}
		if skipped < offset {
			skipped++
			continue
		}
		page.Tasks = append(page.Tasks, snapshotTask(task))
		version ^= uint64(task.ID) + 0x9e3779b97f4a7c15 + (version << 6) + (version >> 2)
		version ^= uint64(task.Revision) * 1099511628211
	}
	page.Version = fmt.Sprintf(`"td-%x"`, version)
	return page
}

func (m *Manager) TaskIDsByStatus(status Status, limit int) []int64 {
	m.mu.RLock()
	defer m.mu.RUnlock()
	capacity := m.statusCounts[status]
	if limit > 0 && capacity > limit {
		capacity = limit
	}
	ids := make([]int64, 0, capacity)
	for _, id := range m.orderedIDs {
		if task := m.tasks[id]; task != nil && task.Status == status {
			ids = append(ids, id)
			if limit > 0 && len(ids) == limit {
				break
			}
		}
	}
	return ids
}

func (m *Manager) TaskCountByStatus(status Status) int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.statusCounts[status]
}

func (m *Manager) summaryLocked() TaskSummary {
	return TaskSummary{
		Total:       len(m.tasks),
		Queued:      m.statusCounts[StatusQueued],
		Downloading: m.statusCounts[StatusDownloading],
		Paused:      m.statusCounts[StatusPaused],
		Done:        m.statusCounts[StatusDone],
		Error:       m.statusCounts[StatusError],
	}
}

func snapshotTask(task *Task) TaskSnapshot {
	return TaskSnapshot{
		ID: task.ID, Name: task.Name, Link: task.Link, Folder: task.Folder,
		OutputName: task.OutputName, Status: task.Status, Progress: task.Progress,
		Error: task.Error, CreatedAt: task.CreatedAt, UpdatedAt: task.UpdatedAt,
	}
}

// RequeueTask keeps aria2's partial file and .aria2 control file so the retry
// resumes verified pieces instead of deleting progress.
func (m *Manager) RequeueTask(id int64) error {
	return singleOperationError(m.RequeueTasks([]int64{id}), id)
}

func (m *Manager) RequeueTasks(ids []int64) TaskOperationResult {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	result := newOperationResult()
	var updates []*Task
	originals := make(map[int64]*Task)
	removeGIDs := make(map[int64]string)
	m.mu.Lock()
	for _, id := range uniqueTaskIDs(ids) {
		task, ok := m.tasks[id]
		if !ok {
			result.fail(id, fmt.Errorf("task %d not found", id))
			continue
		}
		if task.Status != StatusError {
			result.fail(id, fmt.Errorf("task %d is %s, not error", id, task.Status))
			continue
		}
		originals[id] = cloneTask(task)
		removeGIDs[id] = m.rotateGIDLocked(task)
		m.setStatusLocked(task, StatusQueued)
		task.Error = ""
		task.Progress = "Waiting for aria2 to resume partial data"
		m.touchTaskLocked(task)
		updates = append(updates, cloneTask(task))
		result.Succeeded = append(result.Succeeded, id)
	}
	m.mu.Unlock()
	if err := m.store.UpdateBatch(updates); err != nil {
		log.Printf("persist %d requeued tasks: %v", len(updates), err)
		m.mu.Lock()
		for id, original := range originals {
			task := m.tasks[id]
			if task == nil {
				continue
			}
			currentStatus := task.Status
			delete(m.gids, task.GID)
			*task = *original
			m.gids[task.GID] = id
			m.statusCounts[currentStatus]--
			m.statusCounts[task.Status]++
			m.structureRev++
		}
		m.mu.Unlock()
		result.failSucceeded(nil, fmt.Errorf("persist requeued tasks: %w", err))
		return result
	}
	for _, id := range result.Succeeded {
		m.enqueue(submission{id: id, removeGID: removeGIDs[id]})
	}
	return result
}

func (m *Manager) PauseTask(id int64) error {
	return singleOperationError(m.PauseTasks([]int64{id}), id)
}

func (m *Manager) PauseTasks(ids []int64) TaskOperationResult {
	return m.changePauseState(ids, true)
}

func (m *Manager) ResumeTask(id int64) error {
	return singleOperationError(m.ResumeTasks([]int64{id}), id)
}

func (m *Manager) ResumeTasks(ids []int64) TaskOperationResult {
	return m.changePauseState(ids, false)
}

type rpcTarget struct {
	id  int64
	gid string
}

func (m *Manager) changePauseState(ids []int64, pause bool) TaskOperationResult {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	result := newOperationResult()
	var targets []rpcTarget
	m.mu.RLock()
	for _, id := range uniqueTaskIDs(ids) {
		task, ok := m.tasks[id]
		if !ok {
			result.fail(id, fmt.Errorf("task %d not found", id))
			continue
		}
		valid := task.Status == StatusPaused
		if pause {
			valid = task.Status == StatusQueued || task.Status == StatusDownloading
		}
		if !valid {
			result.fail(id, fmt.Errorf("task %d is %s and cannot be %s", id, task.Status, map[bool]string{true: "paused", false: "resumed"}[pause]))
			continue
		}
		targets = append(targets, rpcTarget{id: id, gid: task.GID})
	}
	m.mu.RUnlock()

	missingGIDs := make(map[int64]bool)
	var missingMu sync.Mutex
	errorsByID := runRPCOperations(targets, 8, func(target rpcTarget) error {
		if m.rpc == nil {
			return fmt.Errorf("aria2 is not running")
		}
		var err error
		if pause {
			err = m.rpc.pause(target.gid)
		} else {
			err = m.rpc.unpause(target.gid)
		}
		if isGIDNotFound(err) {
			missingMu.Lock()
			missingGIDs[target.id] = true
			missingMu.Unlock()
			return nil
		}
		return err
	})

	var updates []*Task
	persistedIDs := make(map[int64]struct{})
	var resubmit []int64
	m.mu.Lock()
	for _, target := range targets {
		if err := errorsByID[target.id]; err != nil {
			result.fail(target.id, err)
			continue
		}
		task := m.tasks[target.id]
		if task == nil {
			result.fail(target.id, fmt.Errorf("task %d not found", target.id))
			continue
		}
		if pause {
			if task.Status != StatusQueued && task.Status != StatusDownloading && task.Status != StatusPaused {
				result.fail(target.id, fmt.Errorf("task %d changed to %s", target.id, task.Status))
				continue
			}
			m.setStatusLocked(task, StatusPaused)
			task.Progress = "Paused by aria2"
		} else {
			if task.Status == StatusDownloading {
				result.Succeeded = append(result.Succeeded, target.id)
				continue
			}
			if task.Status != StatusPaused && task.Status != StatusQueued {
				result.fail(target.id, fmt.Errorf("task %d changed to %s", target.id, task.Status))
				continue
			}
			m.setStatusLocked(task, StatusQueued)
			task.Progress = "Waiting for aria2 to resume"
			if missingGIDs[target.id] {
				m.releaseAriaSlotLocked(target.id)
				resubmit = append(resubmit, target.id)
			}
		}
		task.Error = ""
		m.touchTaskLocked(task)
		updates = append(updates, cloneTask(task))
		persistedIDs[target.id] = struct{}{}
		result.Succeeded = append(result.Succeeded, target.id)
	}
	m.mu.Unlock()
	if err := m.store.UpdateBatch(updates); err != nil {
		log.Printf("persist %d pause state changes: %v", len(updates), err)
		result.failSucceeded(persistedIDs, fmt.Errorf("persist pause state: %w", err))
	}
	if !pause {
		for _, id := range resubmit {
			m.enqueue(submission{id: id})
		}
	}
	return result
}

func (m *Manager) DeleteTask(id int64) bool {
	result := m.removeTasks([]int64{id}, false)
	return len(result.Succeeded) == 1
}

// RemoveTasks cancels active aria2 work when necessary and removes only the
// task record. Partial and completed files on disk are deliberately preserved.
func (m *Manager) RemoveTasks(ids []int64) TaskOperationResult {
	return m.removeTasks(ids, true)
}

func (m *Manager) removeTasks(ids []int64, allowActive bool) TaskOperationResult {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	result := newOperationResult()
	var targets []rpcTarget
	active := make(map[int64]bool)
	m.mu.RLock()
	for _, id := range uniqueTaskIDs(ids) {
		task, ok := m.tasks[id]
		if !ok {
			result.fail(id, fmt.Errorf("task %d not found", id))
			continue
		}
		isActive := task.Status == StatusQueued || task.Status == StatusDownloading || task.Status == StatusPaused
		if isActive && !allowActive {
			result.fail(id, fmt.Errorf("task %d is still active", id))
			continue
		}
		targets = append(targets, rpcTarget{id: id, gid: task.GID})
		active[id] = isActive
	}
	m.mu.RUnlock()

	errorsByID := runRPCOperations(targets, 8, func(target rpcTarget) error {
		if m.rpc == nil {
			if active[target.id] {
				return fmt.Errorf("aria2 is not running")
			}
			return nil
		}
		if active[target.id] {
			err := m.rpc.forceRemove(target.gid)
			if err != nil && !isGIDNotFound(err) {
				return err
			}
		}
		if err := m.rpc.removeResult(target.gid); err != nil && !isGIDNotFound(err) {
			log.Printf("remove aria2 result %s: %v", target.gid, err)
		}
		return nil
	})

	removable := make([]int64, 0, len(targets))
	for _, target := range targets {
		if err := errorsByID[target.id]; err != nil {
			result.fail(target.id, err)
			continue
		}
		removable = append(removable, target.id)
	}
	if err := m.store.DeleteBatch(removable); err != nil {
		for _, id := range removable {
			result.fail(id, fmt.Errorf("delete task record: %w", err))
		}
		return result
	}
	m.mu.Lock()
	for _, id := range removable {
		if m.removeTaskLocked(id) {
			result.Succeeded = append(result.Succeeded, id)
		} else {
			result.fail(id, fmt.Errorf("task %d not found", id))
		}
	}
	m.compactOrderedIDsLocked()
	m.mu.Unlock()
	return result
}

func (m *Manager) ClearDone() int {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	m.mu.RLock()
	ids := make([]int64, 0, m.statusCounts[StatusDone])
	for id, task := range m.tasks {
		if task.Status == StatusDone {
			ids = append(ids, id)
		}
	}
	m.mu.RUnlock()
	if err := m.store.ClearDone(); err != nil {
		log.Printf("clear completed records from database: %v", err)
		return 0
	}
	m.mu.Lock()
	for _, id := range ids {
		m.removeTaskLocked(id)
	}
	m.compactOrderedIDsLocked()
	m.mu.Unlock()
	if m.rpc != nil {
		if err := m.rpc.purgeResults(); err != nil {
			log.Printf("purge aria2 results: %v", err)
		}
	}
	return len(ids)
}

func (m *Manager) enqueue(item submission) {
	m.pendingMu.Lock()
	m.pending = append(m.pending, item)
	m.pendingMu.Unlock()
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

func (m *Manager) acquireAriaSlot() bool {
	select {
	case m.ariaSlots <- struct{}{}:
		return true
	case <-m.done:
		return false
	}
}

func (m *Manager) releaseAriaSlot() {
	select {
	case <-m.ariaSlots:
	default:
	}
}

func (m *Manager) releaseAriaSlotLocked(id int64) {
	if m.ariaAdmitted[id] {
		delete(m.ariaAdmitted, id)
		m.releaseAriaSlot()
	}
}

func (m *Manager) enqueueAdmission(item admission) {
	m.admissionMu.Lock()
	m.admissions = append(m.admissions, item)
	m.admissionMu.Unlock()
	select {
	case m.dbWake <- struct{}{}:
	default:
	}
}

func (m *Manager) persistenceWriter() {
	defer m.wg.Done()
	for {
		select {
		case <-m.done:
			m.flushAdmissions(true)
			return
		case <-m.dbWake:
			select {
			case <-m.done:
				m.flushAdmissions(true)
				return
			case <-time.After(2 * time.Millisecond):
			}
			m.flushAdmissions(false)
		}
	}
}

func (m *Manager) flushAdmissions(stopping bool) {
	for {
		m.admissionMu.Lock()
		batchSize := min(len(m.admissions), 256)
		if batchSize == 0 {
			m.admissionMu.Unlock()
			return
		}
		batch := append([]admission(nil), m.admissions[:batchSize]...)
		for index := 0; index < batchSize; index++ {
			m.admissions[index] = admission{}
		}
		m.admissions = m.admissions[batchSize:]
		if len(m.admissions) == 0 {
			m.admissions = nil
		}
		m.admissionMu.Unlock()

		m.opMu.Lock()
		tasks := make([]*Task, 0, len(batch))
		admittedIDs := make([]int64, 0, len(batch))
		m.mu.RLock()
		for _, item := range batch {
			if task := m.tasks[item.id]; task != nil {
				tasks = append(tasks, cloneTask(task))
				admittedIDs = append(admittedIDs, item.id)
			}
		}
		m.mu.RUnlock()
		if err := m.store.InsertBatch(tasks); err != nil {
			log.Printf("persist %d admitted downloads: %v", len(batch), err)
			m.admissionMu.Lock()
			m.admissions = append(batch, m.admissions...)
			m.admissionMu.Unlock()
			m.opMu.Unlock()
			if stopping {
				return
			}
			select {
			case <-m.done:
				stopping = true
			case <-time.After(time.Second):
			}
			continue
		}
		m.opMu.Unlock()
		for _, id := range admittedIDs {
			m.enqueue(submission{id: id})
		}
	}
}

func (m *Manager) dispatcher() {
	defer m.wg.Done()
	for {
		select {
		case <-m.done:
			return
		case <-m.wake:
		}
		for {
			m.pendingMu.Lock()
			if len(m.pending) == 0 {
				m.pendingMu.Unlock()
				break
			}
			item := m.pending[0]
			m.pending[0] = submission{}
			if len(m.pending) == 1 {
				m.pending = nil
			} else {
				m.pending = m.pending[1:]
			}
			m.pendingMu.Unlock()
			select {
			case <-m.done:
				return
			default:
				if !m.acquireAriaSlot() {
					return
				}
				m.opMu.Lock()
				admitted := m.submit(item)
				m.opMu.Unlock()
				if !admitted {
					m.releaseAriaSlot()
				}
			}
		}
	}
}

func (m *Manager) submit(item submission) bool {
	m.mu.RLock()
	task, ok := m.tasks[item.id]
	if !ok || m.ariaAdmitted[item.id] {
		m.mu.RUnlock()
		return false
	}
	snapshot := cloneTask(task)
	m.mu.RUnlock()
	if snapshot.Status != StatusQueued && snapshot.Status != StatusPaused {
		return false
	}
	if err := os.MkdirAll(snapshot.Folder, 0755); err != nil {
		m.failTask(snapshot.ID, fmt.Errorf("create download directory: %w", err))
		return false
	}
	if !item.recheck && snapshot.OutputName != "" {
		var err error
		snapshot, err = m.refreshOutputName(snapshot.ID)
		if err != nil {
			m.failTask(snapshot.ID, err)
			return false
		}
	}
	if item.removeGID != "" {
		if err := m.rpc.removeResult(item.removeGID); err != nil && !isGIDNotFound(err) {
			log.Printf("remove stale aria2 result %s: %v", item.removeGID, err)
		}
	}
	options := ariaOptions(snapshot, item.recheck)
	if err := m.rpc.addURI(snapshot, options); err != nil {
		m.failTask(snapshot.ID, err)
		return false
	}
	m.mu.Lock()
	task = m.tasks[snapshot.ID]
	if task == nil || task.Status == StatusDone || task.Status == StatusError {
		m.mu.Unlock()
		return false
	}
	m.ariaAdmitted[task.ID] = true
	if task.Status == StatusPaused {
		task.Progress = "Paused by aria2"
	} else if task.Status == StatusQueued {
		task.Progress = "Accepted by aria2"
	}
	task.Error = ""
	m.touchTaskLocked(task)
	persisted := cloneTask(task)
	m.mu.Unlock()
	if err := m.store.Update(persisted); err != nil {
		log.Printf("persist admitted task %d: %v", persisted.ID, err)
	}
	return true
}

func (m *Manager) poller() {
	defer m.wg.Done()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-m.done:
			return
		case <-ticker.C:
			statuses, err := m.rpc.statuses()
			if err != nil {
				log.Printf("poll aria2 status: %v", err)
				continue
			}
			m.applyStatuses(statuses)
		}
	}
}

func (m *Manager) applyStatuses(statuses []ariaStatus) {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	updates := make([]*Task, 0, len(statuses))
	m.mu.Lock()
	for _, state := range statuses {
		task := m.tasks[m.gids[state.GID]]
		if task == nil {
			continue
		}
		oldStatus, oldProgress, oldError, oldOutput := task.Status, task.Progress, task.Error, task.OutputName
		m.setStatusLocked(task, statusFromAria(state.Status))
		if task.Status == StatusDone || task.Status == StatusError {
			m.releaseAriaSlotLocked(task.ID)
		}
		task.Progress = formatProgress(state)
		task.Error = ""
		if task.Status == StatusError {
			task.Error = truncateText(state.ErrorMessage, 2048)
			if task.Error == "" {
				task.Error = "aria2 error code " + state.ErrorCode
			}
		}
		if task.OutputName == "" && len(state.Files) > 0 && state.Files[0].Path != "" {
			task.OutputName = filepath.Base(state.Files[0].Path)
			m.outputNames[outputNameKey(task.Folder, task.OutputName)] = task.ID
		}
		if oldStatus != task.Status || oldProgress != task.Progress || oldError != task.Error || oldOutput != task.OutputName {
			m.touchTaskLocked(task)
			updates = append(updates, cloneTask(task))
		}
	}
	m.mu.Unlock()
	if err := m.store.UpdateBatch(updates); err != nil {
		log.Printf("persist %d task statuses: %v", len(updates), err)
	}
}

func (m *Manager) setTask(id int64, update func(*Task)) error {
	m.mu.Lock()
	task, ok := m.tasks[id]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("task %d not found", id)
	}
	oldStatus := task.Status
	update(task)
	if oldStatus != task.Status {
		m.statusCounts[oldStatus]--
		m.statusCounts[task.Status]++
		m.structureRev++
	}
	m.touchTaskLocked(task)
	snapshot := cloneTask(task)
	m.mu.Unlock()
	return m.store.Update(snapshot)
}

func (m *Manager) setStatusLocked(task *Task, status Status) {
	if task.Status == status {
		return
	}
	m.statusCounts[task.Status]--
	task.Status = status
	m.statusCounts[status]++
	m.structureRev++
}

func (m *Manager) rotateGIDLocked(task *Task) string {
	oldGID := task.GID
	delete(m.gids, oldGID)
	task.GID = m.newGIDLocked()
	m.gids[task.GID] = task.ID
	return oldGID
}

func (m *Manager) newGIDLocked() string {
	for {
		gid := newGID()
		if _, exists := m.gids[gid]; !exists {
			return gid
		}
	}
}

func (m *Manager) touchTaskLocked(task *Task) {
	m.revision++
	task.Revision = m.revision
	task.UpdatedAt = time.Now()
}

func (m *Manager) removeTaskLocked(id int64) bool {
	task := m.tasks[id]
	if task == nil {
		return false
	}
	m.releaseAriaSlotLocked(id)
	delete(m.tasks, id)
	delete(m.fingerprints, task.Fingerprint)
	delete(m.gids, task.GID)
	if task.OutputName != "" {
		delete(m.outputNames, outputNameKey(task.Folder, task.OutputName))
	}
	m.statusCounts[task.Status]--
	m.revision++
	m.structureRev++
	return true
}

func (m *Manager) compactOrderedIDsLocked() {
	if len(m.orderedIDs) <= len(m.tasks)+64 {
		return
	}
	ids := m.orderedIDs[:0]
	for _, id := range m.orderedIDs {
		if m.tasks[id] != nil {
			ids = append(ids, id)
		}
	}
	m.orderedIDs = ids
}

func newOperationResult() TaskOperationResult {
	return TaskOperationResult{
		Succeeded: make([]int64, 0),
		Failed:    make([]TaskOperationFailure, 0),
	}
}

func (result *TaskOperationResult) fail(id int64, err error) {
	result.Failed = append(result.Failed, TaskOperationFailure{ID: id, Error: err.Error()})
}

func (result *TaskOperationResult) failSucceeded(ids map[int64]struct{}, err error) {
	kept := result.Succeeded[:0]
	for _, id := range result.Succeeded {
		if ids != nil {
			if _, ok := ids[id]; !ok {
				kept = append(kept, id)
				continue
			}
		}
		result.fail(id, err)
	}
	result.Succeeded = kept
}

func singleOperationError(result TaskOperationResult, id int64) error {
	if len(result.Succeeded) > 0 {
		return nil
	}
	if len(result.Failed) > 0 {
		return fmt.Errorf("%s", result.Failed[0].Error)
	}
	return fmt.Errorf("task %d was not changed", id)
}

func uniqueTaskIDs(ids []int64) []int64 {
	result := make([]int64, 0, len(ids))
	seen := make(map[int64]struct{}, len(ids))
	for _, id := range ids {
		if id <= 0 {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		result = append(result, id)
	}
	return result
}

func runRPCOperations(targets []rpcTarget, concurrency int, operation func(rpcTarget) error) map[int64]error {
	errorsByID := make(map[int64]error, len(targets))
	if len(targets) == 0 {
		return errorsByID
	}
	if concurrency < 1 {
		concurrency = 1
	}
	jobs := make(chan rpcTarget)
	var resultMu sync.Mutex
	var globalError error
	var workers sync.WaitGroup
	for index := 0; index < min(concurrency, len(targets)); index++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for target := range jobs {
				resultMu.Lock()
				priorGlobalError := globalError
				resultMu.Unlock()
				if priorGlobalError != nil {
					resultMu.Lock()
					errorsByID[target.id] = priorGlobalError
					resultMu.Unlock()
					continue
				}
				if err := operation(target); err != nil {
					resultMu.Lock()
					errorsByID[target.id] = err
					var rpcError *ariaRPCError
					if !errors.As(err, &rpcError) {
						globalError = err
					}
					resultMu.Unlock()
				}
			}
		}()
	}
	for _, target := range targets {
		jobs <- target
	}
	close(jobs)
	workers.Wait()
	return errorsByID
}

func (m *Manager) failTask(id int64, err error) {
	if persistErr := m.setTask(id, func(t *Task) {
		t.Status = StatusError
		t.Error = truncateText(err.Error(), 2048)
		t.Progress = ""
	}); persistErr != nil {
		log.Printf("persist failed task %d: %v", id, persistErr)
	}
}

func (m *Manager) startAria2() error {
	if _, err := os.Stat(m.aria2Path); err != nil {
		return fmt.Errorf("aria2 executable: %w", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("reserve aria2 RPC port: %w", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	secretBytes := make([]byte, 16)
	if _, err := rand.Read(secretBytes); err != nil {
		return err
	}
	secret := hex.EncodeToString(secretBytes)
	logPath := filepath.Join(filepath.Dir(m.defaultDir), "aria2.log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return fmt.Errorf("open aria2 log: %w", err)
	}
	args := []string{
		"--enable-rpc=true",
		"--rpc-listen-all=false",
		"--rpc-allow-origin-all=false",
		fmt.Sprintf("--rpc-listen-port=%d", port),
		"--rpc-secret=" + secret,
		"--dir=" + filepath.ToSlash(m.defaultDir),
		"--continue=true",
		"--max-concurrent-downloads=3",
		"--console-log-level=warn",
		"--summary-interval=0",
		"--download-result=full",
		"--keep-unfinished-download-result=true",
		"--max-download-result=256",
	}
	cmd := exec.Command(m.aria2Path, args...)
	cmd.Dir = filepath.Dir(m.aria2Path)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		return fmt.Errorf("start aria2 RPC service: %w", err)
	}
	m.cmd, m.logFile = cmd, logFile
	m.cmdDone = make(chan error, 1)
	go func() { m.cmdDone <- cmd.Wait() }()
	m.rpc = newAriaClient(port, secret)
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		if err := m.rpc.ready(); err == nil {
			return nil
		}
		select {
		case err := <-m.cmdDone:
			_ = logFile.Close()
			return fmt.Errorf("aria2 exited during startup: %w", err)
		case <-time.After(50 * time.Millisecond):
		}
	}
	_ = cmd.Process.Kill()
	_ = logFile.Close()
	return fmt.Errorf("aria2 RPC service did not become ready")
}

func normalizeRequest(link, name, folder, defaultDir string, headers map[string]string, downloadPage string, queueID int, opts Aria2Opts) requestIdentity {
	if folder == "" {
		folder = defaultDir
	}
	cleanHeaders := make(map[string]string, len(headers))
	for key, value := range headers {
		cleanHeaders[strings.TrimSpace(key)] = strings.TrimSpace(value)
	}
	if opts.ExtraArgs == nil {
		opts.ExtraArgs = []string{}
	}
	return requestIdentity{
		Link:         strings.TrimSpace(link),
		Name:         strings.TrimSpace(name),
		Folder:       filepath.Clean(strings.TrimSpace(folder)),
		QueueID:      queueID,
		Headers:      cleanHeaders,
		DownloadPage: strings.TrimSpace(downloadPage),
		Opts:         opts,
	}
}

func validateRequest(identity requestIdentity) error {
	invalid := func(format string, args ...any) error {
		return &ValidationError{Message: fmt.Sprintf(format, args...)}
	}
	if err := validateDownloadURL(identity.Link); err != nil {
		return invalid("invalid download link: %v", err)
	}
	if identity.DownloadPage != "" {
		if err := validateDownloadURL(identity.DownloadPage); err != nil {
			return invalid("invalid download page: %v", err)
		}
	}
	if identity.Name != "" {
		if identity.Name == "." || identity.Name == ".." || filepath.IsAbs(identity.Name) ||
			strings.ContainsAny(identity.Name, `/\\<>:"|?*`) || strings.HasSuffix(identity.Name, " ") ||
			strings.HasSuffix(identity.Name, ".") || utf8.RuneCountInString(identity.Name) > 240 {
			return invalid("invalid output file name")
		}
		for _, char := range identity.Name {
			if char < 32 || char == 127 {
				return invalid("invalid output file name")
			}
		}
		base := strings.ToUpper(strings.SplitN(identity.Name, ".", 2)[0])
		switch base {
		case "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
			"LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9":
			return invalid("invalid output file name")
		}
	}
	if identity.Folder == "" || len(identity.Folder) > 4096 || strings.ContainsRune(identity.Folder, 0) {
		return invalid("invalid download folder")
	}
	if identity.QueueID < 0 || identity.QueueID > 1_000_000 {
		return invalid("queueId must be between 0 and 1000000")
	}
	if identity.Opts.Connections < 0 || identity.Opts.Connections > 64 ||
		identity.Opts.MaxSpeedBps < 0 || int64(identity.Opts.MaxSpeedBps) > 1<<50 ||
		identity.Opts.MaxTries < 0 || identity.Opts.MaxTries > 100 ||
		identity.Opts.RetryWait < 0 || identity.Opts.RetryWait > 3600 {
		return invalid("aria2 options are outside the allowed range")
	}
	if len(identity.Opts.ExtraArgs) > 64 {
		return invalid("too many extra aria2 options")
	}
	for _, raw := range identity.Opts.ExtraArgs {
		value := strings.TrimSpace(strings.TrimPrefix(raw, "--"))
		parts := strings.SplitN(value, "=", 2)
		if len(value) > 4096 || value == "" || !validAriaOptionName(parts[0]) || strings.ContainsAny(value, "\r\n\x00") {
			return invalid("invalid extra aria2 option")
		}
	}
	if len(identity.Headers) > 64 {
		return invalid("too many request headers")
	}
	totalHeaderBytes := 0
	for name, value := range identity.Headers {
		totalHeaderBytes += len(name) + len(value)
		if !validHeaderName(name) || isProtectedRequestHeader(name) || len(value) > 64*1024 || strings.ContainsAny(value, "\r\n\x00") {
			return invalid("invalid request header")
		}
	}
	if totalHeaderBytes > 256*1024 {
		return invalid("request headers are too large")
	}
	return nil
}

func isProtectedRequestHeader(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "host", "content-length", "transfer-encoding", "connection", "proxy-authorization",
		"proxy-authenticate", "trailer", "te", "upgrade":
		return true
	default:
		return false
	}
}

func validateDownloadURL(value string) error {
	if value == "" || len(value) > 16*1024 {
		return fmt.Errorf("URL is empty or too long")
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return fmt.Errorf("only absolute HTTP(S) URLs are supported")
	}
	if parsed.User != nil {
		return fmt.Errorf("credentials in URLs are not supported")
	}
	return nil
}

func validAriaOptionName(value string) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') && (char < '0' || char > '9') && char != '-' {
			return false
		}
	}
	return true
}

func validHeaderName(value string) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		if char <= 32 || char >= 127 || strings.ContainsRune(`()<>@,;:\"/[]?={}`, char) {
			return false
		}
	}
	return true
}

func ariaOptions(task *Task, recheck bool) map[string]any {
	connections := task.Opts.Connections
	if connections <= 0 {
		connections = 16
	}
	maxTries := task.Opts.MaxTries
	if maxTries <= 0 {
		maxTries = 5
	}
	retryWait := task.Opts.RetryWait
	if retryWait <= 0 {
		retryWait = 3
	}
	options := map[string]any{
		"gid":                       task.GID,
		"dir":                       filepath.ToSlash(task.Folder),
		"continue":                  "true",
		"remote-time":               "true",
		"split":                     strconv.Itoa(connections),
		"max-connection-per-server": strconv.Itoa(connections),
		"max-tries":                 strconv.Itoa(maxTries),
		"retry-wait":                strconv.Itoa(retryWait),
		"pause":                     strconv.FormatBool(task.Status == StatusPaused),
	}
	if task.OutputName != "" {
		options["out"] = task.OutputName
		options["auto-file-renaming"] = "false"
	}
	if task.Opts.MaxSpeedBps > 0 {
		options["max-download-limit"] = strconv.Itoa(task.Opts.MaxSpeedBps)
	}
	if len(task.Headers) > 0 {
		keys := make([]string, 0, len(task.Headers))
		for key := range task.Headers {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		headerLines := make([]string, 0, len(keys))
		for _, key := range keys {
			headerLines = append(headerLines, key+": "+task.Headers[key])
		}
		options["header"] = headerLines
	}
	if task.DownloadPage != "" {
		options["referer"] = task.DownloadPage
	}
	for _, raw := range task.Opts.ExtraArgs {
		value := strings.TrimSpace(strings.TrimPrefix(raw, "--"))
		if value == "" {
			continue
		}
		parts := strings.SplitN(value, "=", 2)
		optionValue := "true"
		if len(parts) == 2 {
			optionValue = parts[1]
		}
		optionName := strings.ToLower(parts[0])
		if isProtectedAriaOption(optionName) {
			continue
		}
		options[optionName] = optionValue
	}
	if recheck {
		options["conditional-get"] = "true"
		options["allow-overwrite"] = "true"
		options["auto-file-renaming"] = "false"
	}
	return options
}

func isProtectedAriaOption(name string) bool {
	switch name {
	case "gid", "dir", "out", "pause", "continue", "conditional-get", "allow-overwrite", "auto-file-renaming",
		"header", "referer", "enable-rpc", "input-file", "save-session", "log",
		"ca-certificate", "certificate", "private-key", "load-cookies", "save-cookies", "netrc-path",
		"server-stat-of", "server-stat-if", "dht-file-path", "dht-file-path6", "torrent-file", "metalink-file",
		"parameterized-uri", "index-out", "select-file", "follow-torrent", "follow-metalink", "bt-save-metadata", "bt-metadata-only":
		return true
	default:
		return strings.HasPrefix(name, "rpc-") || strings.HasPrefix(name, "on-")
	}
}

func statusFromAria(status string) Status {
	switch status {
	case "active":
		return StatusDownloading
	case "waiting":
		return StatusQueued
	case "paused":
		return StatusPaused
	case "complete":
		return StatusDone
	default:
		return StatusError
	}
}

func formatProgress(state ariaStatus) string {
	completed, _ := strconv.ParseInt(state.CompletedLength, 10, 64)
	total, _ := strconv.ParseInt(state.TotalLength, 10, 64)
	speed, _ := strconv.ParseInt(state.DownloadSpeed, 10, 64)
	if state.Status == "paused" {
		return fmt.Sprintf("Paused at %s / %s", formatBytes(completed), formatBytes(total))
	}
	if total <= 0 {
		return fmt.Sprintf("%s downloaded, %s/s", formatBytes(completed), formatBytes(speed))
	}
	return fmt.Sprintf("%.1f%% (%s / %s), %s/s", float64(completed)*100/float64(total), formatBytes(completed), formatBytes(total), formatBytes(speed))
}

func truncateText(value string, maxBytes int) string {
	if len(value) <= maxBytes {
		return value
	}
	value = value[:maxBytes]
	for !utf8.ValidString(value) {
		value = value[:len(value)-1]
	}
	return value + "..."
}

func formatBytes(value int64) string {
	units := []string{"B", "KiB", "MiB", "GiB", "TiB"}
	n := float64(value)
	unit := 0
	for n >= 1024 && unit < len(units)-1 {
		n /= 1024
		unit++
	}
	if unit == 0 {
		return fmt.Sprintf("%d %s", value, units[unit])
	}
	return fmt.Sprintf("%.1f %s", n, units[unit])
}

func newGID() string {
	bytes := make([]byte, 8)
	if _, err := rand.Read(bytes); err == nil {
		return hex.EncodeToString(bytes)
	}
	return fmt.Sprintf("%016x", time.Now().UnixNano())
}

func displayName(link string) string {
	parsed, err := url.Parse(link)
	if err == nil {
		name, unescapeErr := url.PathUnescape(filepath.Base(parsed.Path))
		if unescapeErr == nil && name != "" && name != "." && name != "/" {
			return name
		}
	}
	return "download"
}

func cloneTask(task *Task) *Task {
	clone := *task
	clone.Headers = make(map[string]string, len(task.Headers))
	for key, value := range task.Headers {
		clone.Headers[key] = value
	}
	clone.Opts.ExtraArgs = append([]string(nil), task.Opts.ExtraArgs...)
	return &clone
}

func resolveAvailableOutputName(name string, available func(string) bool) string {
	if available(name) {
		return name
	}
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	for i := 1; i < 10000; i++ {
		candidate := fmt.Sprintf("%s(%d)%s", base, i, ext)
		if available(candidate) {
			return candidate
		}
	}
	return name
}

func (m *Manager) resolveOutputNameLocked(dir, name string, excludeID int64) string {
	return resolveAvailableOutputName(name, func(candidate string) bool {
		if !outputNameAvailable(dir, candidate) {
			return false
		}
		if id, occupied := m.outputNames[outputNameKey(dir, candidate)]; occupied && id != excludeID {
			return false
		}
		return true
	})
}

func (m *Manager) refreshOutputName(id int64) (*Task, error) {
	m.mu.Lock()
	task, ok := m.tasks[id]
	if !ok {
		m.mu.Unlock()
		return nil, fmt.Errorf("task %d not found", id)
	}
	changed := false
	outputPath := filepath.Join(task.Folder, task.OutputName)
	controlPath := outputPath + ".aria2"
	if pathExists(outputPath) && !pathExists(controlPath) {
		delete(m.outputNames, outputNameKey(task.Folder, task.OutputName))
		task.OutputName = m.resolveOutputNameLocked(task.Folder, task.Name, task.ID)
		m.outputNames[outputNameKey(task.Folder, task.OutputName)] = task.ID
		m.touchTaskLocked(task)
		changed = true
	}
	snapshot := cloneTask(task)
	m.mu.Unlock()
	if changed {
		if err := m.store.Update(snapshot); err != nil {
			return nil, fmt.Errorf("persist corrected output name: %w", err)
		}
	}
	return snapshot, nil
}

func outputNameKey(dir, name string) string {
	return strings.ToLower(filepath.Clean(dir)) + "\x00" + strings.ToLower(name)
}

func pathExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil || !os.IsNotExist(err)
}

func outputNameAvailable(dir, name string) bool {
	for _, path := range []string{filepath.Join(dir, name), filepath.Join(dir, name+".aria2")} {
		if pathExists(path) {
			return false
		}
	}
	return true
}
