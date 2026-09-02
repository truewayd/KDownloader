package downloader

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"mime"
	"net"
	"net/http"
	"net/http/cookiejar"
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

// ManagerConfig describes capabilities of the engine selected by TrueDown.
type ManagerConfig struct {
	Aria2Next        bool
	Aria2NextVersion string
	EngineExit       func(*Manager, error)
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
	TotalLength  int64             `json:"-"`

	Fingerprint   string `json:"-"`
	RequestJSON   string `json:"-"`
	ModuleID      string `json:"-"`
	DropboxDirect bool   `json:"-"`
	RemoteDigest  string `json:"-"`
	RemoteName    string `json:"-"`
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

type EngineStartError struct{ Err error }

func (e *EngineStartError) Error() string { return e.Err.Error() }
func (e *EngineStartError) Unwrap() error { return e.Err }

func IsEngineStartError(err error) bool {
	_, ok := err.(*EngineStartError)
	return ok
}

type requestIdentity struct {
	Link         string              `json:"link"`
	Name         string              `json:"name"`
	Folder       string              `json:"folder"`
	QueueID      int                 `json:"queueId"`
	Headers      map[string]string   `json:"headers"`
	DownloadPage string              `json:"downloadPage"`
	Opts         Aria2Opts           `json:"opts"`
	ModuleID     string              `json:"-"`
	BitTorrent   *bitTorrentIdentity `json:"bitTorrent,omitempty"`
}

type submission struct {
	id             int64
	recheck        bool
	removeGID      string
	discardPartial bool
	partialPath    string
}

type admission struct {
	id int64
}

type dropboxMetadata struct {
	URL         string
	Name        string
	Digest      string
	Length      int64
	LengthKnown bool
}

type ariaRPC interface {
	ready() error
	addURI(*Task, map[string]any) error
	pause(string) error
	unpause(string) error
	pauseAll() error
	unpauseAll() error
	changeGlobalOptions(map[string]string) error
	forceRemove(string) error
	status(string) (ariaStatus, error)
	removeResult(string) error
	purgeResults() error
	shutdown() error
	statuses() ([]ariaStatus, error)
}

type Manager struct {
	aria2Path        string
	aria2Next        bool
	aria2NextVersion string
	ariaStateDir     string
	defaultDir       string
	store            *recordStore
	downloadRules    *downloadRulesStore
	runtimeSettings  *runtimeSettingsStore
	modules          *moduleRegistry
	trackerResearch  *trackerResearchModule

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

	pendingMu    sync.Mutex
	pending      []submission
	wake         chan struct{}
	done         chan struct{}
	wg           sync.WaitGroup
	stopOnce     sync.Once
	engineExited atomic.Bool
	engineExit   func(*Manager, error)
	lifecycleCtx context.Context
	cancel       context.CancelFunc

	rpc     ariaRPC
	cmd     *exec.Cmd
	cmdDone chan error
	logFile *os.File

	dropboxClient     *http.Client
	dropboxProxy      func(*http.Request) (*url.URL, error)
	googleDriveClient *http.Client
	googleDriveProxy  func(*http.Request) (*url.URL, error)
	openPath          func(string) error
}

func NewManager(aria2Path, defaultDir, databasePath string) (*Manager, error) {
	return NewManagerWithConfig(aria2Path, defaultDir, databasePath, ManagerConfig{})
}

func NewManagerWithConfig(aria2Path, defaultDir, databasePath string, config ManagerConfig) (*Manager, error) {
	store, err := openRecordStore(databasePath)
	if err != nil {
		return nil, err
	}
	tasks, err := store.LoadAll()
	if err != nil {
		store.Close()
		return nil, fmt.Errorf("load download records: %w", err)
	}
	downloadRules, err := newDownloadRulesStore(databasePath)
	if err != nil {
		store.Close()
		return nil, err
	}
	runtimeSettings, err := newRuntimeSettingsStore(databasePath)
	if err != nil {
		store.Close()
		return nil, err
	}
	modules, err := newModuleRegistry(databasePath)
	if err != nil {
		store.Close()
		return nil, err
	}
	trackerResearch, err := newTrackerResearchModule(databasePath)
	if err != nil {
		store.Close()
		return nil, err
	}
	dropboxProxy := systemProxyFunc()
	googleDriveProxy := systemProxyFunc()
	lifecycleCtx, cancel := context.WithCancel(context.Background())
	m := &Manager{
		aria2Path:         aria2Path,
		aria2Next:         config.Aria2Next,
		aria2NextVersion:  strings.TrimSpace(config.Aria2NextVersion),
		ariaStateDir:      filepath.Join(filepath.Dir(databasePath), "aria2-next-state"),
		defaultDir:        defaultDir,
		store:             store,
		downloadRules:     downloadRules,
		runtimeSettings:   runtimeSettings,
		modules:           modules,
		trackerResearch:   trackerResearch,
		tasks:             make(map[int64]*Task, len(tasks)),
		fingerprints:      make(map[string]int64, len(tasks)),
		gids:              make(map[string]int64, len(tasks)),
		outputNames:       make(map[string]int64, len(tasks)),
		orderedIDs:        make([]int64, 0, len(tasks)),
		statusCounts:      make(map[Status]int, 5),
		ariaAdmitted:      make(map[int64]bool, ariaBacklogLimit),
		ariaSlots:         make(chan struct{}, ariaBacklogLimit),
		dropboxClient:     newDropboxHTTPClient(dropboxProxy),
		dropboxProxy:      dropboxProxy,
		googleDriveClient: newGoogleDriveHTTPClient(googleDriveProxy),
		googleDriveProxy:  googleDriveProxy,
		openPath:          systemOpenPath,
		wake:              make(chan struct{}, 1),
		dbWake:            make(chan struct{}, 1),
		done:              make(chan struct{}),
		lifecycleCtx:      lifecycleCtx,
		cancel:            cancel,
		engineExit:        config.EngineExit,
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
		return &EngineStartError{Err: err}
	}
	if m.trackerResearch.snapshot().Enabled {
		if err := m.trackerResearch.prepare(m.rpc); err != nil {
			log.Printf("tracker research remains inactive: %v", err)
		}
	} else {
		_ = m.trackerResearch.inspectSupport(m.rpc)
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
			restored = append(restored, snapshotTaskUpdate(task))
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
		if m.cancel != nil {
			m.cancel()
		}
		close(m.done)
		m.wg.Wait()
		if m.rpc != nil {
			m.trackerResearch.restoreAllIfSupported(m.rpc)
			m.trackerResearch.close()
			_ = m.rpc.shutdown()
		} else {
			m.trackerResearch.close()
		}
		if m.cmdDone != nil {
			if !waitForManagedCommand(m.cmd, m.cmdDone, 4*time.Second, 2*time.Second) {
				log.Printf("timed out reaping the aria2 process after shutdown")
			}
		}
		if m.logFile != nil {
			_ = m.logFile.Close()
		}
		if m.dropboxClient != nil {
			m.dropboxClient.CloseIdleConnections()
		}
		if m.googleDriveClient != nil {
			m.googleDriveClient.CloseIdleConnections()
		}
		if m.store != nil {
			_ = m.store.Close()
		}
	})
}

func waitForManagedCommand(command *exec.Cmd, done <-chan error, gracefulTimeout, killTimeout time.Duration) bool {
	timer := time.NewTimer(gracefulTimeout)
	defer timer.Stop()
	select {
	case <-done:
		return true
	case <-timer.C:
	}
	if command == nil || command.Process == nil {
		return false
	}
	if err := command.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		log.Printf("kill aria2 process after shutdown timeout: %v", err)
	}
	timer.Reset(killTimeout)
	select {
	case <-done:
		return true
	case <-timer.C:
		return false
	}
}

// AddTask records the request and returns immediately. Persistence and aria2
// admission run asynchronously behind a bounded aria2 backlog window.
func (m *Manager) AddTask(link, name, folder string, headers map[string]string, downloadPage string, queueID int, opts Aria2Opts) (*Task, bool, error) {
	return m.addTaskWithModule(link, name, folder, headers, downloadPage, queueID, opts, m.installedModuleID(link))
}

func (m *Manager) addTaskWithModule(link, name, folder string, headers map[string]string, downloadPage string, queueID int, opts Aria2Opts, moduleID string) (*Task, bool, error) {
	m.opMu.Lock()
	defer m.opMu.Unlock()

	identity := normalizeRequest(link, name, folder, m.defaultDir, headers, downloadPage, queueID, opts)
	identity.ModuleID = moduleID
	if err := validateRequest(identity); err != nil {
		return nil, false, err
	}
	return m.addIdentityLocked(identity, moduleID)
}

func (m *Manager) addIdentityLocked(identity requestIdentity, moduleID string) (*Task, bool, error) {
	requestJSON, err := json.Marshal(identity)
	if err != nil {
		return nil, false, err
	}
	fingerprintBytes := sha256.Sum256(requestJSON)
	fingerprint := hex.EncodeToString(fingerprintBytes[:])

	m.mu.Lock()
	if task := m.findModuleResumeLocked(identity, fingerprint); task != nil {
		removeGID := task.GID
		proposed := cloneTask(task)
		proposed.GID = m.newGIDLocked()
		proposed.Fingerprint = fingerprint
		proposed.RequestJSON = string(requestJSON)
		proposed.Link = identity.Link
		proposed.Headers = identity.Headers
		proposed.DownloadPage = identity.DownloadPage
		proposed.QueueID = identity.QueueID
		proposed.Opts = identity.Opts
		proposed.ModuleID = moduleID
		proposed.DropboxDirect = moduleID == DropboxModuleID
		proposed.Status = StatusQueued
		proposed.Error = ""
		proposed.Progress = "Waiting for aria2 to verify and resume partial data"
		proposed.Revision = m.revision + 1
		proposed.UpdatedAt = time.Now()
		// This rare resume path keeps the task lock through the SQLite commit so
		// the poller cannot advance the same task before the index swap.
		if err := m.store.UpdateRequest(proposed); err != nil {
			m.mu.Unlock()
			return nil, true, err
		}
		m.revision = proposed.Revision
		m.replaceTaskLocked(task, proposed)
		result := cloneTask(task)
		m.mu.Unlock()
		m.enqueue(submission{id: result.ID, removeGID: removeGID})
		return result, true, nil
	}
	if id, ok := m.fingerprints[fingerprint]; ok {
		task := m.tasks[id]
		shouldRecheck := task.Status == StatusDone || task.Status == StatusError
		if !shouldRecheck {
			result := cloneTask(task)
			m.mu.Unlock()
			return result, true, nil
		}
		removeGID := task.GID
		proposed := cloneTask(task)
		proposed.GID = m.newGIDLocked()
		proposed.Status = StatusQueued
		proposed.Error = ""
		proposed.Progress = "Checking whether the remote content has changed"
		proposed.Revision = m.revision + 1
		proposed.UpdatedAt = time.Now()
		if err := m.store.Update(proposed); err != nil {
			m.mu.Unlock()
			return nil, true, err
		}
		m.revision = proposed.Revision
		m.replaceTaskLocked(task, proposed)
		result := cloneTask(task)
		m.mu.Unlock()
		m.enqueue(submission{id: id, recheck: true, removeGID: removeGID})
		return result, true, nil
	}

	now := time.Now()
	task := &Task{
		ID:            m.nextID.Add(1),
		Fingerprint:   fingerprint,
		RequestJSON:   string(requestJSON),
		Name:          identity.Name,
		Link:          identity.Link,
		Folder:        identity.Folder,
		Headers:       identity.Headers,
		DownloadPage:  identity.DownloadPage,
		QueueID:       identity.QueueID,
		Opts:          identity.Opts,
		ModuleID:      moduleID,
		DropboxDirect: moduleID == DropboxModuleID,
		GID:           m.newGIDLocked(),
		Status:        StatusQueued,
		Progress:      "Waiting for aria2",
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	m.touchTaskLocked(task)
	if identity.BitTorrent == nil {
		if task.Name != "" {
			task.OutputName = m.resolveOutputNameLocked(task.Folder, task.Name, task.ID)
		} else {
			task.Name = displayName(task.Link)
		}
	} else if task.Name == "" {
		task.Name = torrentLinkName(task.Link)
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

// findModuleResumeLocked locates an errored resolver task whose partial data
// can be validated by aria2. Redirected content URLs are deliberately absent
// from the identity because modules refresh them before every admission.
func (m *Manager) findModuleResumeLocked(identity requestIdentity, fingerprint string) *Task {
	module := m.modules.module(identity.ModuleID)
	if module == nil || !module.supportsPartialResume(identity.Link) {
		return nil
	}
	name := identity.Name
	if name == "" {
		name = displayName(identity.Link)
	}
	eligible := func(task *Task) bool {
		if task == nil || task.ModuleID != identity.ModuleID || task.Status != StatusError || task.OutputName == "" {
			return false
		}
		if !samePathName(task.Folder, identity.Folder) || !samePathName(task.Name, name) {
			return false
		}
		outputPath := filepath.Join(task.Folder, task.OutputName)
		return pathExists(outputPath) && pathExists(outputPath+".aria2")
	}
	if id, ok := m.fingerprints[fingerprint]; ok {
		if task := m.tasks[id]; eligible(task) {
			return task
		}
		return nil
	}
	for index := len(m.orderedIDs) - 1; index >= 0; index-- {
		if task := m.tasks[m.orderedIDs[index]]; eligible(task) {
			return task
		}
	}
	return nil
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
// cloning the full task map. A status filter of "" includes every task. Search
// matches the requested file name or download link case-insensitively.
func (m *Manager) PageTaskSnapshots(offset, limit int, status Status, search string) TaskPage {
	return m.PageTaskSnapshotsSorted(offset, limit, status, search, "", "")
}

// PageTaskSnapshotsSorted returns a globally sorted page when sortField is set.
// The response remains bounded even though an explicit sort must inspect all
// matching in-memory task identities to stay correct across pages.
func (m *Manager) PageTaskSnapshotsSorted(offset, limit int, status Status, search, sortField, sortOrder string) TaskPage {
	page, _ := m.PageTaskSnapshotsSortedIfChanged(offset, limit, status, search, sortField, sortOrder, "")
	return page
}

// PageTaskSnapshotsSortedIfChanged avoids rebuilding a globally sorted or
// searched page when its revision-based validator still matches.
func (m *Manager) PageTaskSnapshotsSortedIfChanged(
	offset, limit int,
	status Status,
	search, sortField, sortOrder, ifNoneMatch string,
) (TaskPage, bool) {
	if offset < 0 {
		offset = 0
	}
	if limit < 1 {
		limit = 100
	}
	search = strings.ToLower(strings.TrimSpace(search))
	sortField = strings.ToLower(strings.TrimSpace(sortField))
	sortOrder = strings.ToLower(strings.TrimSpace(sortOrder))
	m.mu.RLock()
	defer m.mu.RUnlock()

	version := uint64(m.structureRev) ^ uint64(offset+1)*1099511628211 ^ uint64(limit)
	for _, value := range []string{string(status), search, sortField, sortOrder} {
		for _, char := range value {
			version ^= uint64(char) + 0x9e3779b97f4a7c15 + (version << 6) + (version >> 2)
		}
		version ^= uint64(':') + 0x9e3779b97f4a7c15 + (version << 6) + (version >> 2)
	}
	usesGlobalRevision := search != "" || sortField != ""
	if usesGlobalRevision {
		version ^= uint64(m.revision) * 1099511628211
		validator := fmt.Sprintf(`"td-%x"`, version)
		if ifNoneMatch != "" && ifNoneMatch == validator {
			return TaskPage{Version: validator}, true
		}
	}

	total := len(m.tasks)
	if status != "" {
		total = m.statusCounts[status]
	}
	if search != "" {
		total = 0
		for _, task := range m.tasks {
			if taskMatchesPage(task, status, search) {
				total++
			}
		}
	}
	page := TaskPage{
		Tasks:    make([]TaskSnapshot, 0, min(limit, max(0, total-offset))),
		Summary:  m.summaryLocked(),
		Offset:   offset,
		Limit:    limit,
		Total:    total,
		Revision: m.revision,
	}
	if sortField != "" {
		if sortField == "id" {
			m.appendTaskPageByID(&page, status, search, sortOrder == "desc")
			page.Version = fmt.Sprintf(`"td-%x"`, version)
			return page, ifNoneMatch != "" && ifNoneMatch == page.Version
		}
		if sortField == "status" {
			m.appendTaskPageByStatus(&page, status, search, sortOrder == "desc")
			page.Version = fmt.Sprintf(`"td-%x"`, version)
			return page, ifNoneMatch != "" && ifNoneMatch == page.Version
		}
		ids := make([]int64, 0, total)
		for _, id := range m.orderedIDs {
			if task := m.tasks[id]; taskMatchesPage(task, status, search) {
				ids = append(ids, id)
			}
		}
		sort.SliceStable(ids, func(left, right int) bool {
			first := m.tasks[ids[left]]
			second := m.tasks[ids[right]]
			comparison := compareTasksForPage(first, second, sortField)
			if comparison == 0 {
				comparison = compareInt64(first.ID, second.ID)
			}
			if sortOrder == "desc" {
				return comparison > 0
			}
			return comparison < 0
		})
		for index := offset; index < len(ids) && len(page.Tasks) < limit; index++ {
			task := m.tasks[ids[index]]
			page.Tasks = append(page.Tasks, snapshotTask(task))
		}
		page.Version = fmt.Sprintf(`"td-%x"`, version)
		return page, ifNoneMatch != "" && ifNoneMatch == page.Version
	}
	skipped := 0
	for index := len(m.orderedIDs) - 1; index >= 0 && len(page.Tasks) < limit; index-- {
		task := m.tasks[m.orderedIDs[index]]
		if !taskMatchesPage(task, status, search) {
			continue
		}
		if skipped < offset {
			skipped++
			continue
		}
		page.Tasks = append(page.Tasks, snapshotTask(task))
		if !usesGlobalRevision {
			version ^= uint64(task.ID) + 0x9e3779b97f4a7c15 + (version << 6) + (version >> 2)
			version ^= uint64(task.Revision) * 1099511628211
		}
	}
	page.Version = fmt.Sprintf(`"td-%x"`, version)
	return page, ifNoneMatch != "" && ifNoneMatch == page.Version
}

func (m *Manager) appendTaskPageByID(page *TaskPage, status Status, search string, descending bool) {
	skipped := 0
	if descending {
		for index := len(m.orderedIDs) - 1; index >= 0 && len(page.Tasks) < page.Limit; index-- {
			appendTaskToPage(page, m.tasks[m.orderedIDs[index]], status, search, &skipped)
		}
		return
	}
	for _, id := range m.orderedIDs {
		if len(page.Tasks) >= page.Limit {
			return
		}
		appendTaskToPage(page, m.tasks[id], status, search, &skipped)
	}
}

func (m *Manager) appendTaskPageByStatus(page *TaskPage, status Status, search string, descending bool) {
	skipped := 0
	ranks := [6]int{0, 1, 2, 3, 4, 5}
	rankCount := len(ranks)
	if status != "" {
		ranks[0] = taskStatusSortRank(status)
		rankCount = 1
	} else if descending {
		ranks = [6]int{5, 4, 3, 2, 1, 0}
	}
	for _, rank := range ranks[:rankCount] {
		if status == "" && search == "" {
			if rankedStatus, known := taskStatusForSortRank(rank); known {
				count := m.statusCounts[rankedStatus]
				if count == 0 {
					continue
				}
				if skipped+count <= page.Offset {
					skipped += count
					continue
				}
			}
		}
		if descending {
			for index := len(m.orderedIDs) - 1; index >= 0 && len(page.Tasks) < page.Limit; index-- {
				task := m.tasks[m.orderedIDs[index]]
				if task != nil && taskStatusSortRank(task.Status) == rank {
					appendTaskToPage(page, task, status, search, &skipped)
				}
			}
			continue
		}
		for _, id := range m.orderedIDs {
			if len(page.Tasks) >= page.Limit {
				return
			}
			task := m.tasks[id]
			if task != nil && taskStatusSortRank(task.Status) == rank {
				appendTaskToPage(page, task, status, search, &skipped)
			}
		}
	}
}

func appendTaskToPage(page *TaskPage, task *Task, status Status, search string, skipped *int) {
	if !taskMatchesPage(task, status, search) {
		return
	}
	if *skipped < page.Offset {
		*skipped++
		return
	}
	page.Tasks = append(page.Tasks, snapshotTask(task))
}

func compareTasksForPage(first, second *Task, field string) int {
	switch field {
	case "id":
		return compareInt64(first.ID, second.ID)
	case "file":
		firstName := first.OutputName
		if firstName == "" {
			firstName = first.Name
		}
		secondName := second.OutputName
		if secondName == "" {
			secondName = second.Name
		}
		return compareFold(firstName, secondName)
	case "status":
		return taskStatusSortRank(first.Status) - taskStatusSortRank(second.Status)
	case "link":
		return compareFold(first.Link, second.Link)
	case "progress":
		firstProgress := first.Progress
		if first.Error != "" {
			firstProgress = first.Error
		}
		secondProgress := second.Progress
		if second.Error != "" {
			secondProgress = second.Error
		}
		firstPercent, firstHasPercent := progressPercent(firstProgress)
		secondPercent, secondHasPercent := progressPercent(secondProgress)
		if firstHasPercent && secondHasPercent {
			if firstPercent < secondPercent {
				return -1
			}
			if firstPercent > secondPercent {
				return 1
			}
		}
		if firstHasPercent != secondHasPercent {
			if firstHasPercent {
				return -1
			}
			return 1
		}
		return compareFold(firstProgress, secondProgress)
	default:
		return compareInt64(first.ID, second.ID)
	}
}

func progressPercent(value string) (float64, bool) {
	value = strings.TrimSpace(value)
	separator := strings.IndexByte(value, '%')
	if separator <= 0 {
		return 0, false
	}
	percent, err := strconv.ParseFloat(strings.TrimSpace(value[:separator]), 64)
	return percent, err == nil
}

func compareInt64(first, second int64) int {
	if first < second {
		return -1
	}
	if first > second {
		return 1
	}
	return 0
}

func taskStatusSortRank(status Status) int {
	switch status {
	case StatusDownloading:
		return 0
	case StatusQueued:
		return 1
	case StatusPaused:
		return 2
	case StatusError:
		return 3
	case StatusDone:
		return 4
	default:
		return 5
	}
}

func taskStatusForSortRank(rank int) (Status, bool) {
	switch rank {
	case 0:
		return StatusDownloading, true
	case 1:
		return StatusQueued, true
	case 2:
		return StatusPaused, true
	case 3:
		return StatusError, true
	case 4:
		return StatusDone, true
	default:
		return "", false
	}
}

func taskMatchesPage(task *Task, status Status, search string) bool {
	if task == nil || (status != "" && task.Status != status) {
		return false
	}
	if search == "" {
		return true
	}
	return containsFold(task.OutputName, search) ||
		containsFold(task.Name, search) ||
		containsFold(task.Link, search)
}

func compareFold(left, right string) int {
	if isASCII(left) && isASCII(right) {
		limit := min(len(left), len(right))
		for index := 0; index < limit; index++ {
			leftByte := lowerASCII(left[index])
			rightByte := lowerASCII(right[index])
			if leftByte < rightByte {
				return -1
			}
			if leftByte > rightByte {
				return 1
			}
		}
		return len(left) - len(right)
	}
	return strings.Compare(strings.ToLower(left), strings.ToLower(right))
}

func containsFold(value, lowerNeedle string) bool {
	if isASCII(value) && isASCII(lowerNeedle) {
		if len(lowerNeedle) > len(value) {
			return false
		}
		if strings.Contains(value, lowerNeedle) {
			return true
		}
		// Keep adversarial long searches on the standard linear-time matcher.
		// Short dashboard searches use the allocation-free folded loop below.
		if len(lowerNeedle) > 32 {
			return strings.Contains(strings.ToLower(value), lowerNeedle)
		}
		for start := 0; start <= len(value)-len(lowerNeedle); start++ {
			matched := true
			for index := 0; index < len(lowerNeedle); index++ {
				if lowerASCII(value[start+index]) != lowerNeedle[index] {
					matched = false
					break
				}
			}
			if matched {
				return true
			}
		}
		return false
	}
	return strings.Contains(strings.ToLower(value), lowerNeedle)
}

func isASCII(value string) bool {
	for index := 0; index < len(value); index++ {
		if value[index] >= utf8.RuneSelf {
			return false
		}
	}
	return true
}

func lowerASCII(value byte) byte {
	if value >= 'A' && value <= 'Z' {
		return value + ('a' - 'A')
	}
	return value
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

// HasActiveBitTorrent reports whether changing to the stable HTTP-only engine
// would strand an unfinished Aria2 Next task.
func (m *Manager) HasActiveBitTorrent() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, task := range m.tasks {
		if task.Status != StatusQueued && task.Status != StatusDownloading && task.Status != StatusPaused {
			continue
		}
		var identity requestIdentity
		if task.RequestJSON != "" && json.Unmarshal([]byte(task.RequestJSON), &identity) == nil && identity.BitTorrent != nil {
			return true
		}
	}
	return false
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

// RequeueTask normally keeps aria2's partial data. Aria2 Next HTTP range
// mismatches are restarted cleanly because those bytes cannot be safely joined
// to the current remote object.
func (m *Manager) RequeueTask(id int64) error {
	return singleOperationError(m.RequeueTasks([]int64{id}), id)
}

func (m *Manager) RequeueTasks(ids []int64) TaskOperationResult {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	result := newOperationResult()
	if m.engineExited.Load() {
		for _, id := range uniqueTaskIDs(ids) {
			result.fail(id, fmt.Errorf("download engine is not running; restart TrueDown before retrying task %d", id))
		}
		return result
	}
	var updates []*Task
	originals := make(map[int64]*Task)
	removeGIDs := make(map[int64]string)
	discardPartials := make(map[int64]bool)
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
		discardPartials[id] = m.aria2Next && requiresCleanHTTPRestart(task.Error)
		removeGIDs[id] = m.rotateGIDLocked(task)
		m.setStatusLocked(task, StatusQueued)
		task.Error = ""
		if discardPartials[id] {
			task.Progress = "HTTP resume state is stale; clearing partial data before restarting from zero"
		} else {
			task.Progress = "Waiting for aria2 to resume partial data"
		}
		m.touchTaskLocked(task)
		updates = append(updates, snapshotTaskUpdate(task))
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
	partialPaths := make(map[string]string)
	needsPartialPath := false
	for _, discard := range discardPartials {
		needsPartialPath = needsPartialPath || discard
	}
	if needsPartialPath && m.rpc != nil {
		if statuses, statusErr := m.rpc.statuses(); statusErr == nil {
			for _, state := range statuses {
				if len(state.Files) > 0 && state.Files[0].Path != "" {
					partialPaths[state.GID] = state.Files[0].Path
				}
			}
		}
	}
	for _, id := range result.Succeeded {
		m.enqueue(submission{
			id: id, removeGID: removeGIDs[id], discardPartial: discardPartials[id], partialPath: partialPaths[removeGIDs[id]],
		})
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

// PauseQueue pauses every queued or active task with one aria2-wide RPC call.
func (m *Manager) PauseQueue() TaskOperationResult {
	return m.changeQueuePauseState(true)
}

// ResumeQueue resumes every paused task with one aria2-wide RPC call.
func (m *Manager) ResumeQueue() TaskOperationResult {
	return m.changeQueuePauseState(false)
}

func (m *Manager) changeQueuePauseState(pause bool) TaskOperationResult {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	result := newOperationResult()
	m.mu.RLock()
	ids := make([]int64, 0)
	for _, id := range m.orderedIDs {
		task := m.tasks[id]
		if task == nil {
			continue
		}
		eligible := task.Status == StatusPaused
		if pause {
			eligible = task.Status == StatusQueued || task.Status == StatusDownloading
		}
		if eligible {
			ids = append(ids, id)
		}
	}
	m.mu.RUnlock()
	if len(ids) == 0 {
		return result
	}
	if m.rpc == nil {
		for _, id := range ids {
			result.fail(id, fmt.Errorf("aria2 is not running"))
		}
		return result
	}
	var err error
	if pause {
		err = m.rpc.pauseAll()
	} else {
		err = m.rpc.unpauseAll()
	}
	if err != nil {
		for _, id := range ids {
			result.fail(id, err)
		}
		return result
	}
	updates := make([]*Task, 0, len(ids))
	resubmit := make([]int64, 0)
	m.mu.Lock()
	for _, id := range ids {
		task := m.tasks[id]
		if task == nil {
			continue
		}
		if pause {
			if task.Status != StatusQueued && task.Status != StatusDownloading {
				continue
			}
			m.setStatusLocked(task, StatusPaused)
			task.Progress = "Paused with the TrueDown queue"
		} else {
			if task.Status != StatusPaused {
				continue
			}
			m.setStatusLocked(task, StatusQueued)
			task.Progress = "Waiting for aria2 to resume"
			if !m.ariaAdmitted[id] {
				resubmit = append(resubmit, id)
			}
		}
		task.Error = ""
		m.touchTaskLocked(task)
		updates = append(updates, snapshotTaskUpdate(task))
		result.Succeeded = append(result.Succeeded, id)
	}
	m.mu.Unlock()
	if err := m.store.UpdateBatch(updates); err != nil {
		log.Printf("persist %d queue pause state changes: %v", len(updates), err)
		result.failSucceeded(nil, fmt.Errorf("persist queue pause state: %w", err))
		return result
	}
	if !pause {
		for _, id := range resubmit {
			m.enqueue(submission{id: id})
		}
	}
	return result
}

type rpcTarget struct {
	id   int64
	gid  string
	task *Task
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
		updates = append(updates, snapshotTaskUpdate(task))
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

// RemoveTasks cancels active aria2 work when necessary. Completed downloads
// are preserved, while an aria2-confirmed active download has its partial data
// and control file removed before its task record is deleted.
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
		targets = append(targets, rpcTarget{id: id, gid: task.GID, task: cloneTask(task)})
		active[id] = isActive
	}
	m.mu.RUnlock()

	partialPaths := make(map[int64]string)
	var partialPathsMu sync.Mutex
	errorsByID := runRPCOperations(targets, 8, func(target rpcTarget) error {
		if m.rpc == nil {
			if active[target.id] {
				return fmt.Errorf("aria2 is not running")
			}
			return nil
		}
		if active[target.id] {
			state, err := m.rpc.status(target.gid)
			if err != nil {
				if isGIDNotFound(err) {
					return nil
				}
				return err
			}
			switch state.Status {
			case "active", "waiting", "paused":
				if err := m.rpc.forceRemove(target.gid); err != nil {
					if isGIDNotFound(err) {
						return nil
					}
					return err
				}
				stopped, err := waitForAriaStop(m.rpc, target.gid)
				if err != nil {
					return err
				}
				if stopped.Status == "complete" || stopped.Status == "error" {
					return nil
				}
				path := ""
				if len(stopped.Files) > 0 {
					path = stopped.Files[0].Path
				} else if len(state.Files) > 0 {
					path = state.Files[0].Path
				}
				partialPathsMu.Lock()
				partialPaths[target.id] = path
				partialPathsMu.Unlock()
			case "removed":
				path := ""
				if len(state.Files) > 0 {
					path = state.Files[0].Path
				}
				partialPathsMu.Lock()
				partialPaths[target.id] = path
				partialPathsMu.Unlock()
			case "complete", "error":
				// The aria2 state is authoritative when the local poller lags.
			default:
				return fmt.Errorf("unexpected aria2 status %q", state.Status)
			}
		}
		return nil
	})
	for _, target := range targets {
		if errorsByID[target.id] != nil {
			continue
		}
		path, shouldRemove := partialPaths[target.id]
		if !shouldRemove {
			continue
		}
		if err := removePartialFiles(target.task, path); err != nil {
			errorsByID[target.id] = err
		}
	}
	resultTargets := make([]rpcTarget, 0, len(targets))
	for _, target := range targets {
		if errorsByID[target.id] == nil {
			resultTargets = append(resultTargets, target)
		}
	}
	_ = runRPCOperations(resultTargets, 8, func(target rpcTarget) error {
		if m.rpc == nil {
			return nil
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
	coalesceTimer := time.NewTimer(time.Hour)
	stopAndDrainTimer(coalesceTimer)
	defer coalesceTimer.Stop()
	for {
		select {
		case <-m.done:
			m.flushAdmissions(true)
			return
		case <-m.dbWake:
			coalesceTimer.Reset(2 * time.Millisecond)
			select {
			case <-m.done:
				stopAndDrainTimer(coalesceTimer)
				m.flushAdmissions(true)
				return
			case <-coalesceTimer.C:
			}
			m.flushAdmissions(false)
		}
	}
}

func stopAndDrainTimer(timer *time.Timer) {
	if timer.Stop() {
		return
	}
	select {
	case <-timer.C:
	default:
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
	if m.engineExited.Load() {
		m.failTask(snapshot.ID, fmt.Errorf("download engine stopped unexpectedly; restart TrueDown before retrying"))
		return false
	}
	if err := os.MkdirAll(snapshot.Folder, 0755); err != nil {
		m.failTask(snapshot.ID, fmt.Errorf("create download directory: %w", err))
		return false
	}
	stalePartialPath := strings.TrimSpace(item.partialPath)
	var stalePathErr error
	if item.discardPartial && item.removeGID != "" {
		if state, err := m.rpc.status(item.removeGID); err == nil && len(state.Files) > 0 && stalePartialPath == "" {
			stalePartialPath = state.Files[0].Path
		} else if err != nil {
			stalePathErr = err
		}
	}
	if item.removeGID != "" {
		if err := m.rpc.removeResult(item.removeGID); err != nil && !isGIDNotFound(err) {
			log.Printf("remove stale aria2 result %s: %v", item.removeGID, err)
		}
	}
	if item.discardPartial {
		if stalePartialPath == "" && snapshot.OutputName == "" && stalePathErr != nil {
			m.failTask(snapshot.ID, fmt.Errorf("download engine became unavailable while locating stale partial data; restart TrueDown: %w", stalePathErr))
			return false
		}
		if err := removePartialFiles(snapshot, stalePartialPath); err != nil {
			m.failTask(snapshot.ID, fmt.Errorf("discard stale HTTP partial data: %w", err))
			return false
		}
		log.Printf("task %d discarded stale HTTP partial data after a byte-range mismatch; restarting from zero", snapshot.ID)
	}
	preparedProxy := ""
	preparedLink := ""
	var preparedHeaders map[string]string
	if module := m.modules.module(snapshot.ModuleID); module != nil {
		prepareContext, cancel := context.WithTimeout(m.lifecycleCtx, 5*time.Minute)
		prepared, err := module.prepare(prepareContext, m, snapshot)
		cancel()
		if err != nil {
			if errors.Is(err, context.Canceled) && m.lifecycleCtx.Err() != nil {
				return false
			}
			m.failTask(snapshot.ID, err)
			return false
		}
		snapshot, err = m.applyRemoteMetadata(snapshot.ID, prepared.Metadata, !item.recheck, module.info().Name)
		if err != nil {
			m.failTask(snapshot.ID, err)
			return false
		}
		preparedLink = prepared.Link
		preparedHeaders = prepared.Headers
		preparedProxy = prepared.ProxyURL
	}
	if !item.recheck && snapshot.OutputName != "" {
		var err error
		snapshot, err = m.refreshOutputName(snapshot.ID)
		if err != nil {
			m.failTask(snapshot.ID, err)
			return false
		}
	}
	if preparedLink != "" {
		snapshot.Link = preparedLink
	}
	if preparedHeaders != nil {
		snapshot.Headers = preparedHeaders
	}
	options := ariaOptions(snapshot, item.recheck)
	var identity requestIdentity
	isBitTorrent := snapshot.RequestJSON != "" && json.Unmarshal([]byte(snapshot.RequestJSON), &identity) == nil && identity.BitTorrent != nil
	if isBitTorrent && m.aria2Next {
		options["check-integrity"] = "true"
	}
	if preparedProxy != "" {
		options["https-proxy"] = preparedProxy
	}
	attachedToNativeTorrent := false
	if m.aria2Next {
		if state, err := m.rpc.status(snapshot.GID); err == nil && state.Bittorrent != nil &&
			(state.Status == "active" || state.Status == "waiting" || state.Status == "paused" || state.Status == "complete") {
			attachedToNativeTorrent = true
		}
	}
	if !attachedToNativeTorrent {
		var addErr error
		if isBitTorrent && identity.BitTorrent.Kind == "file" {
			if torrentRPC, ok := m.rpc.(torrentAddRPC); ok {
				addErr = torrentRPC.addTorrent(snapshot, identity.BitTorrent.TorrentBase64, options)
			} else {
				addErr = errors.New("active aria2 RPC does not support imported torrent files")
			}
		} else {
			addErr = m.rpc.addURI(snapshot, options)
		}
		if addErr != nil {
			m.failTask(snapshot.ID, addErr)
			return false
		}
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
		if attachedToNativeTorrent {
			task.Progress = "Restored by Aria2 Next; checking local torrent data"
		} else {
			task.Progress = "Accepted by aria2"
		}
	}
	task.Error = ""
	m.touchTaskLocked(task)
	persisted := snapshotTaskUpdate(task)
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
		case err, ok := <-m.cmdDone:
			if !ok {
				err = nil
			}
			m.handleUnexpectedEngineExit(err)
			return
		case <-ticker.C:
			statuses, err := m.rpc.statuses()
			if err != nil {
				log.Printf("poll aria2 status: %v", err)
				continue
			}
			m.applyStatuses(statuses)
			m.trackerResearch.sync(m.rpc, statuses)
		}
	}
}

func (m *Manager) handleUnexpectedEngineExit(err error) {
	if !m.engineExited.CompareAndSwap(false, true) {
		return
	}
	reason := "the process exited without an error status"
	if err != nil {
		reason = err.Error()
	}
	message := "Download engine stopped unexpectedly; restart TrueDown"
	recovering := m.engineExit != nil
	if recovering {
		message = "Download engine stopped unexpectedly; TrueDown is recovering it"
	}
	log.Printf("aria2 process exited unexpectedly (%s)", reason)

	m.opMu.Lock()
	defer m.opMu.Unlock()
	updates := make([]*Task, 0)
	m.mu.Lock()
	for _, task := range m.tasks {
		switch task.Status {
		case StatusQueued, StatusDownloading, StatusPaused:
			m.releaseAriaSlotLocked(task.ID)
			if recovering {
				if task.Status != StatusPaused {
					m.setStatusLocked(task, StatusQueued)
				}
				task.Progress = message
				task.Error = ""
			} else {
				m.setStatusLocked(task, StatusError)
				task.Progress = ""
				task.Error = message
			}
			m.touchTaskLocked(task)
			updates = append(updates, snapshotTaskUpdate(task))
		}
	}
	m.mu.Unlock()
	if err := m.store.UpdateBatch(updates); err != nil {
		log.Printf("persist %d tasks after aria2 exited: %v", len(updates), err)
	}
	if m.engineExit != nil {
		go m.engineExit(m, err)
	}
}

func (m *Manager) applyStatuses(statuses []ariaStatus) {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	updates := make([]*Task, 0, len(statuses))
	diagnosticLogs := make([]string, 0)
	statesByGID := make(map[string]ariaStatus, len(statuses))
	for _, state := range statuses {
		statesByGID[state.GID] = state
	}
	m.mu.Lock()
	for _, parent := range statuses {
		if len(parent.FollowedBy) == 0 {
			continue
		}
		task := m.tasks[m.gids[parent.GID]]
		if task == nil {
			continue
		}
		childGID := ""
		for _, candidate := range parent.FollowedBy {
			child, ok := statesByGID[candidate]
			if ok && child.Bittorrent != nil {
				childGID = candidate
				break
			}
		}
		if childGID == "" {
			continue
		}
		if owner, exists := m.gids[childGID]; exists && owner != task.ID {
			continue
		}
		delete(m.gids, parent.GID)
		task.GID = childGID
		m.gids[childGID] = task.ID
		task.Progress = "Torrent metadata loaded; checking local files"
		m.touchTaskLocked(task)
		updates = append(updates, snapshotTaskUpdate(task))
	}
	for _, state := range statuses {
		task := m.tasks[m.gids[state.GID]]
		if task == nil {
			continue
		}
		oldStatus, oldProgress, oldError, oldOutput := task.Status, task.Progress, task.Error, task.OutputName
		oldTotalLength := task.TotalLength
		m.setStatusLocked(task, statusFromAria(state.Status))
		if task.Status == StatusDone || task.Status == StatusError {
			m.releaseAriaSlotLocked(task.ID)
		}
		nextProgress := formatProgress(state)
		if state.Bittorrent != nil && oldProgress != nextProgress {
			speed, _ := strconv.ParseInt(state.DownloadSpeed, 10, 64)
			if speed <= 0 {
				diagnosticLogs = append(diagnosticLogs, fmt.Sprintf("BT task %d zero-speed diagnostics: %s", task.ID, bitTorrentProgressDetails(state)))
			} else if bitTorrentProgressWasIdle(oldProgress) {
				diagnosticLogs = append(diagnosticLogs, fmt.Sprintf("BT task %d transfer resumed at %s/s", task.ID, formatBytes(speed)))
			}
		}
		task.Progress = nextProgress
		task.Error = ""
		if task.Status == StatusError {
			task.Error = truncateText(state.ErrorMessage, 2048)
			if task.Error == "" {
				task.Error = "aria2 error code " + state.ErrorCode
			}
			if requiresCleanHTTPRestart(task.Error) && oldError != task.Error {
				diagnosticLogs = append(diagnosticLogs, fmt.Sprintf("task %d HTTP byte-range resume state no longer matches the remote object; retry will discard only this task's partial file and restart from zero", task.ID))
			}
		}
		if task.OutputName == "" && len(state.Files) > 0 && state.Files[0].Path != "" {
			task.OutputName = taskOutputRootName(task.Folder, state.Files[0].Path)
			m.outputNames[outputNameKey(task.Folder, task.OutputName)] = task.ID
		}
		if totalLength, err := strconv.ParseInt(state.TotalLength, 10, 64); err == nil && totalLength >= 0 {
			task.TotalLength = totalLength
		}
		if oldStatus != task.Status || oldProgress != task.Progress || oldError != task.Error || oldOutput != task.OutputName || oldTotalLength != task.TotalLength {
			m.touchTaskLocked(task)
			updates = append(updates, snapshotTaskUpdate(task))
		}
	}
	m.mu.Unlock()
	for _, entry := range diagnosticLogs {
		log.Print(entry)
	}
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
	snapshot := snapshotTaskUpdate(task)
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

// replaceTaskLocked commits a task snapshot while keeping every secondary
// index in sync. The caller must hold m.mu and persist replacement first.
func (m *Manager) replaceTaskLocked(task, replacement *Task) {
	oldStatus := task.Status
	if m.fingerprints[task.Fingerprint] == task.ID {
		delete(m.fingerprints, task.Fingerprint)
	}
	if m.gids[task.GID] == task.ID {
		delete(m.gids, task.GID)
	}
	if task.OutputName != "" {
		key := outputNameKey(task.Folder, task.OutputName)
		if m.outputNames[key] == task.ID {
			delete(m.outputNames, key)
		}
	}

	*task = *cloneTask(replacement)
	m.fingerprints[task.Fingerprint] = task.ID
	m.gids[task.GID] = task.ID
	if task.OutputName != "" {
		m.outputNames[outputNameKey(task.Folder, task.OutputName)] = task.ID
	}
	if oldStatus != task.Status {
		m.statusCounts[oldStatus]--
		m.statusCounts[task.Status]++
		m.structureRev++
	}
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
	dataDir := filepath.Dir(m.defaultDir)
	logPath := filepath.Join(dataDir, "aria2.log")
	consoleLogPath := logPath
	if m.aria2Next && aria2NextSupportsNativeDiagnostics(m.aria2NextVersion) {
		// Aria2 Next 2.6.5+ owns a bounded rotating file log with native
		// libtorrent diagnostics. Keep its console stream separate so the
		// two writers never race on the same file.
		consoleLogPath = filepath.Join(dataDir, "aria2-console.log")
		prepared, prepareErr := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if prepareErr != nil {
			return fmt.Errorf("prepare aria2 log: %w", prepareErr)
		}
		_ = prepared.Close()
	}
	logFile, err := os.OpenFile(consoleLogPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return fmt.Errorf("open aria2 console log: %w", err)
	}
	runtimeSettings := m.RuntimeSettings()
	if m.aria2Next && aria2NextSupportsBTResumeSave(m.aria2NextVersion) {
		if err := os.MkdirAll(m.ariaStateDir, 0700); err != nil {
			_ = logFile.Close()
			return fmt.Errorf("create Aria2 Next state directory: %w", err)
		}
	}
	args := m.aria2StartArgs(port, secret, runtimeSettings)
	cmd := exec.Command(m.aria2Path, args...)
	cmd.Dir = filepath.Dir(m.aria2Path)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	configureManagedProcess(cmd)
	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		return fmt.Errorf("start aria2 RPC service: %w", err)
	}
	cmdDone := make(chan error, 1)
	go func() {
		cmdDone <- cmd.Wait()
		close(cmdDone)
	}()
	rpc := newAriaClient(port, secret)
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		if err := rpc.ready(); err == nil {
			m.cmd, m.logFile, m.cmdDone, m.rpc = cmd, logFile, cmdDone, rpc
			if m.aria2Next && aria2NextSupportsNativeDiagnostics(m.aria2NextVersion) {
				log.Printf("Aria2 Next %s native diagnostics: debug log=%s, rotation=4x10MiB, console log=%s", m.aria2NextVersion, logPath, consoleLogPath)
				log.Printf("BitTorrent identity is owned by Aria2 Next/libtorrent: versioned A2 peer fingerprint; retired peer-agent and peer-id-prefix inputs are not effective")
			} else {
				log.Printf("aria2 summarized diagnostics: log=%s, console-level=info, summary-interval=5s", consoleLogPath)
			}
			return nil
		}
		select {
		case err := <-cmdDone:
			_ = logFile.Close()
			if err == nil {
				return fmt.Errorf("aria2 exited before its RPC service became ready")
			}
			return fmt.Errorf("aria2 exited during startup: %w", err)
		case <-time.After(50 * time.Millisecond):
		}
	}
	_ = cmd.Process.Kill()
	select {
	case <-cmdDone:
	case <-time.After(2 * time.Second):
	}
	_ = logFile.Close()
	return fmt.Errorf("aria2 RPC service did not become ready")
}

func (m *Manager) aria2StartArgs(port int, secret string, runtimeSettings RuntimeSettings) []string {
	consoleLogLevel := "info"
	summaryInterval := 5
	if m.aria2Next && aria2NextSupportsNativeDiagnostics(m.aria2NextVersion) {
		consoleLogLevel = "warn"
		summaryInterval = 0
	}
	args := []string{
		"--enable-rpc=true",
		"--rpc-listen-all=false",
		"--rpc-allow-origin-all=false",
		fmt.Sprintf("--rpc-listen-port=%d", port),
		"--rpc-secret=" + secret,
		"--dir=" + filepath.ToSlash(m.defaultDir),
		"--continue=true",
		"--auto-save-interval=5",
		fmt.Sprintf("--max-concurrent-downloads=%d", runtimeSettings.ConcurrentDownloads),
		fmt.Sprintf("--max-overall-download-limit=%d", runtimeSettings.GlobalDownloadLimitBps),
		"--console-log-level=" + consoleLogLevel,
		fmt.Sprintf("--summary-interval=%d", summaryInterval),
		"--download-result=full",
		"--keep-unfinished-download-result=true",
		"--max-download-result=256",
	}
	if m.aria2Next {
		args = append(args, "--check-integrity=true")
		if aria2NextSupportsNativeDiagnostics(m.aria2NextVersion) {
			args = append(args,
				"--log="+filepath.ToSlash(filepath.Join(filepath.Dir(m.defaultDir), "aria2.log")),
				"--log-level=debug",
				"--log-max-size=10M",
				"--log-max-files=4",
			)
		}
		if aria2NextSupportsNativeState(m.aria2NextVersion) {
			args = append(args, "--state-dir="+filepath.ToSlash(m.ariaStateDir))
		} else if aria2NextSupportsBTResumeSave(m.aria2NextVersion) {
			args = append(args, "--bt-session-state-file="+filepath.ToSlash(filepath.Join(m.ariaStateDir, "bittorrent.session")))
		}
		if aria2NextSupportsBTResumeSave(m.aria2NextVersion) {
			args = append(args, "--bt-resume-save-interval=1")
		}
	}
	return args
}

func aria2NextSupportsNativeState(version string) bool {
	return aria2NextVersionAtLeast(version, 2, 6, 0)
}

func aria2NextSupportsBTResumeSave(version string) bool {
	return aria2NextVersionAtLeast(version, 2, 5, 7)
}

func aria2NextSupportsNativeDiagnostics(version string) bool {
	return aria2NextVersionAtLeast(version, 2, 6, 5)
}

func aria2NextVersionAtLeast(version string, requiredMajor, requiredMinor, requiredPatch int) bool {
	parts := strings.Split(strings.TrimSpace(version), ".")
	if len(parts) != 3 {
		return false
	}
	values := [3]int{}
	for index, part := range parts {
		value, err := strconv.Atoi(part)
		if err != nil || value < 0 {
			return false
		}
		values[index] = value
	}
	required := [3]int{requiredMajor, requiredMinor, requiredPatch}
	for index, value := range values {
		if value != required[index] {
			return value > required[index]
		}
	}
	return true
}

func normalizeRequest(link, name, folder, defaultDir string, headers map[string]string, downloadPage string, queueID int, opts Aria2Opts) requestIdentity {
	folder = strings.TrimSpace(folder)
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
		Folder:       filepath.Clean(folder),
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
	if identity.BitTorrent != nil {
		if err := validateBitTorrentIdentity(identity); err != nil {
			return invalid("invalid BitTorrent source: %v", err)
		}
	} else if err := validateDownloadURL(identity.Link); err != nil {
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

func isDropboxDirectDownload(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	if host != "dropbox.com" && !strings.HasSuffix(host, ".dropbox.com") {
		return false
	}
	return parsed.Query().Get("dl") == "1"
}

func isDropboxFolderDownload(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil || !isDropboxDirectDownload(value) {
		return false
	}
	segments := strings.Split(strings.Trim(strings.ToLower(parsed.EscapedPath()), "/"), "/")
	if len(segments) == 4 && segments[0] == "scl" && segments[1] == "fo" {
		return true
	}
	return len(segments) == 2 && segments[0] == "sh"
}

func isDropboxHost(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	return host == "dropbox.com" || strings.HasSuffix(host, ".dropbox.com")
}

func isDropboxContentHost(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	return host == "dropboxusercontent.com" || strings.HasSuffix(host, ".dropboxusercontent.com")
}

func newDropboxHTTPClient(proxy func(*http.Request) (*url.URL, error)) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = proxy
	transport.DisableCompression = true
	jar, _ := cookiejar.New(nil)
	return &http.Client{
		Transport: transport,
		Jar:       jar,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return fmt.Errorf("too many Dropbox redirects")
			}
			if req.URL.Scheme != "https" || (!isDropboxHost(req.URL.Hostname()) && !isDropboxContentHost(req.URL.Hostname())) {
				return fmt.Errorf("Dropbox redirected to an untrusted host")
			}
			if isDropboxContentHost(req.URL.Hostname()) {
				for _, name := range []string{"Authorization", "Cookie", "Origin", "Proxy-Authorization"} {
					req.Header.Del(name)
				}
			}
			return nil
		},
	}
}

func resolveDropboxDirectURL(task *Task, client *http.Client) (dropboxMetadata, error) {
	if task == nil || !isDropboxDirectDownload(task.Link) {
		return dropboxMetadata{}, fmt.Errorf("task does not contain a Dropbox dl=1 link")
	}
	if client == nil {
		return dropboxMetadata{}, fmt.Errorf("Dropbox resolver is unavailable")
	}
	if isDropboxFolderDownload(task.Link) {
		metadata, err := requestDropboxMetadata(task, client, http.MethodGet, 5*time.Minute)
		if err != nil {
			return dropboxMetadata{}, fmt.Errorf("refresh Dropbox folder archive URL: %w", err)
		}
		return metadata, nil
	}
	var headErr error
	if metadata, err := requestDropboxMetadata(task, client, http.MethodHead, 20*time.Second); err == nil {
		return metadata, nil
	} else {
		headErr = err
	}
	metadata, getErr := requestDropboxMetadata(task, client, http.MethodGet, 20*time.Second)
	if getErr == nil {
		return metadata, nil
	}
	return dropboxMetadata{}, fmt.Errorf("refresh Dropbox download URL: HEAD: %v; GET: %v", headErr, getErr)
}

func requestDropboxMetadata(task *Task, client *http.Client, method string, timeout time.Duration) (dropboxMetadata, error) {
	request, err := http.NewRequest(method, task.Link, nil)
	if err != nil {
		return dropboxMetadata{}, err
	}
	for name, value := range task.Headers {
		switch strings.ToLower(strings.TrimSpace(name)) {
		case "accept", "accept-encoding", "content-length", "host", "range":
			continue
		}
		request.Header.Set(name, value)
	}
	request.Header.Set("Accept", "*/*")
	request.Header.Set("Accept-Encoding", "identity")
	if method == http.MethodGet {
		request.Header.Set("Range", "bytes=0-0")
	}
	ctx, cancel := context.WithTimeout(request.Context(), timeout)
	defer cancel()
	request = request.WithContext(ctx)
	response, err := client.Do(request)
	if err != nil {
		return dropboxMetadata{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return dropboxMetadata{}, fmt.Errorf("Dropbox metadata request returned HTTP %d", response.StatusCode)
	}
	if response.Request == nil || !isResolvedDropboxContentURL(task.Link, response.Request.URL) {
		return dropboxMetadata{}, fmt.Errorf("Dropbox did not return a trusted content URL")
	}
	metadata := dropboxMetadata{URL: response.Request.URL.String()}
	metadata.Name = contentDispositionName(response.Header.Get("Content-Disposition"))
	metadata.Digest = strings.TrimSpace(response.Header.Get("Repr-Digest"))
	if metadata.Digest == "" && (method == http.MethodHead || response.StatusCode == http.StatusOK) {
		metadata.Digest = strings.TrimSpace(response.Header.Get("Content-Digest"))
		if metadata.Digest == "" {
			metadata.Digest = strings.TrimSpace(response.Header.Get("Digest"))
		}
	}
	metadata.Length, metadata.LengthKnown = responseTotalLength(response, method)
	return metadata, nil
}

func isResolvedDropboxContentURL(original string, resolved *url.URL) bool {
	if resolved == nil || resolved.Scheme != "https" {
		return false
	}
	if isDropboxContentHost(resolved.Hostname()) {
		return true
	}
	if !isDropboxHost(resolved.Hostname()) || !strings.Contains(strings.ToLower(resolved.EscapedPath()), "/s/dl") {
		return false
	}
	return resolved.String() != original
}

func dropboxContentHeaders(headers map[string]string) map[string]string {
	filtered := make(map[string]string, len(headers))
	for name, value := range headers {
		switch strings.ToLower(strings.TrimSpace(name)) {
		case "authorization", "cookie", "origin", "proxy-authorization":
			continue
		}
		filtered[name] = value
	}
	return filtered
}

func responseTotalLength(response *http.Response, method string) (int64, bool) {
	contentRange := strings.TrimSpace(response.Header.Get("Content-Range"))
	if slash := strings.LastIndex(contentRange, "/"); slash >= 0 && slash+1 < len(contentRange) {
		if total, err := strconv.ParseInt(strings.TrimSpace(contentRange[slash+1:]), 10, 64); err == nil && total >= 0 {
			return total, true
		}
	}
	if method == http.MethodHead || response.StatusCode == http.StatusOK {
		if value := strings.TrimSpace(response.Header.Get("Content-Length")); value != "" {
			if total, err := strconv.ParseInt(value, 10, 64); err == nil && total >= 0 {
				return total, true
			}
		}
		if response.ContentLength >= 0 {
			return response.ContentLength, true
		}
	}
	return 0, false
}

func contentDispositionName(value string) string {
	_, params, err := mime.ParseMediaType(value)
	if err != nil {
		return ""
	}
	name := filepath.Base(strings.TrimSpace(params["filename"]))
	if name == "" || name == "." || name == string(filepath.Separator) {
		return ""
	}
	return name
}

func validateDropboxMetadata(task *Task, metadata dropboxMetadata) error {
	expectedName := expectedDropboxRemoteName(task)
	if expectedName != "" && metadata.Name != "" && !samePathName(expectedName, metadata.Name) {
		return fmt.Errorf("Dropbox file name changed from %q to %q", expectedName, metadata.Name)
	}
	if task.TotalLength > 0 && metadata.LengthKnown && task.TotalLength != metadata.Length {
		return fmt.Errorf("Dropbox file size changed from %d to %d bytes", task.TotalLength, metadata.Length)
	}
	if task.RemoteDigest != "" && metadata.Digest != "" && task.RemoteDigest != metadata.Digest {
		return fmt.Errorf("Dropbox file Digest changed")
	}
	return nil
}

func expectedDropboxRemoteName(task *Task) string {
	if task == nil {
		return ""
	}
	if task.RemoteName != "" {
		return task.RemoteName
	}
	var identity requestIdentity
	if task.RequestJSON != "" && json.Unmarshal([]byte(task.RequestJSON), &identity) == nil && identity.Name == "" {
		return task.OutputName
	}
	return task.Name
}

func (m *Manager) applyDropboxMetadata(id int64, metadata dropboxMetadata, enforceIdentity bool) (*Task, error) {
	return m.applyRemoteMetadata(id, remoteMetadata{
		URL: metadata.URL, Name: metadata.Name, Digest: metadata.Digest,
		Length: metadata.Length, LengthKnown: metadata.LengthKnown,
	}, enforceIdentity, "Dropbox")
}

func (m *Manager) applyRemoteMetadata(id int64, metadata remoteMetadata, enforceIdentity bool, moduleName string) (*Task, error) {
	m.mu.Lock()
	task := m.tasks[id]
	if task == nil {
		m.mu.Unlock()
		return nil, fmt.Errorf("task %d not found", id)
	}
	if enforceIdentity {
		if err := validateRemoteMetadata(task, metadata, moduleName); err != nil {
			m.mu.Unlock()
			return nil, err
		}
	}
	changed := false
	if metadata.LengthKnown && metadata.Length > 0 && (task.TotalLength == 0 || (!enforceIdentity && task.TotalLength != metadata.Length)) {
		task.TotalLength = metadata.Length
		changed = true
	}
	if metadata.Digest != "" && (task.RemoteDigest == "" || (!enforceIdentity && task.RemoteDigest != metadata.Digest)) {
		task.RemoteDigest = metadata.Digest
		changed = true
	}
	if metadata.Name != "" && (task.RemoteName == "" || (!enforceIdentity && !samePathName(task.RemoteName, metadata.Name))) {
		task.RemoteName = metadata.Name
		changed = true
	}
	if task.OutputName == "" && metadata.Name != "" {
		task.OutputName = m.resolveOutputNameLocked(task.Folder, metadata.Name, task.ID)
		m.outputNames[outputNameKey(task.Folder, task.OutputName)] = task.ID
		var identity requestIdentity
		if task.RequestJSON != "" && json.Unmarshal([]byte(task.RequestJSON), &identity) == nil && identity.Name == "" {
			task.Name = metadata.Name
		}
		changed = true
	}
	if changed {
		m.touchTaskLocked(task)
	}
	snapshot := cloneTask(task)
	m.mu.Unlock()
	if changed {
		if err := m.store.Update(snapshot); err != nil {
			return nil, fmt.Errorf("persist %s metadata: %w", moduleName, err)
		}
	}
	return snapshot, nil
}

func validateRemoteMetadata(task *Task, metadata remoteMetadata, moduleName string) error {
	expectedName := expectedDropboxRemoteName(task)
	if expectedName != "" && metadata.Name != "" && !samePathName(expectedName, metadata.Name) {
		return fmt.Errorf("%s file name changed from %q to %q", moduleName, expectedName, metadata.Name)
	}
	if task.TotalLength > 0 && metadata.LengthKnown && task.TotalLength != metadata.Length {
		return fmt.Errorf("%s file size changed from %d to %d bytes", moduleName, task.TotalLength, metadata.Length)
	}
	if task.RemoteDigest != "" && metadata.Digest != "" && task.RemoteDigest != metadata.Digest {
		return fmt.Errorf("%s file Digest changed", moduleName)
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

func requiresCleanHTTPRestart(message string) bool {
	return strings.Contains(strings.ToLower(message), "the requested byte range is no longer satisfiable")
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
	if task.ModuleID != "" {
		// Digest metadata is not guaranteed, but an existing aria2 control file
		// must be checked before a resolver task resumes from a refreshed URL.
		options["check-integrity"] = "true"
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
		"max-concurrent-downloads", "max-overall-download-limit",
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
		return appendBitTorrentProgress(fmt.Sprintf("Paused at %s / %s", formatBytes(completed), formatBytes(total)), state)
	}
	progress := ""
	if total <= 0 {
		progress = fmt.Sprintf("%s downloaded, %s/s", formatBytes(completed), formatBytes(speed))
	} else {
		progress = fmt.Sprintf("%.1f%% (%s / %s), %s/s", float64(completed)*100/float64(total), formatBytes(completed), formatBytes(total), formatBytes(speed))
	}
	return appendBitTorrentProgress(progress, state)
}

func appendBitTorrentProgress(progress string, state ariaStatus) string {
	details := bitTorrentProgressDetails(state)
	if details == "" {
		return progress
	}
	return progress + " | " + details
}

func bitTorrentProgressDetails(state ariaStatus) string {
	bt := state.Bittorrent
	if bt == nil {
		return ""
	}
	peers := firstParsedInt(bt.NumPeers, state.Connections)
	seeds := firstParsedInt(bt.NumSeeds, state.NumSeeders)
	connecting := parsedInt(bt.ConnectingPeers)
	handshaking := parsedInt(bt.HandshakingPeers)
	candidates := parsedInt(bt.ConnectCandidates)
	trackers := 0
	for _, tier := range bt.AnnounceList {
		trackers += len(tier)
	}
	details := fmt.Sprintf("BT %s: %d peers, %d seeds, %d trackers", firstNonEmptyString(bt.State, "active"), peers, seeds, trackers)
	if connecting > 0 || handshaking > 0 || candidates > 0 {
		details += fmt.Sprintf(" (%d connecting, %d handshaking, %d candidates)", connecting, handshaking, candidates)
	}
	if availability, err := strconv.ParseFloat(bt.Availability, 64); err == nil && availability >= 0 {
		details += fmt.Sprintf(", availability %.1f%%", availability*100)
	}
	if bt.Error != nil {
		category := firstNonEmptyString(bt.Error.Category, bt.Error.Kind, "engine")
		details += ", " + category + " error"
		if bt.Error.Recoverable == "true" {
			details += " (recoverable)"
		}
	}
	return details
}

func bitTorrentProgressWasIdle(progress string) bool {
	return strings.Contains(progress, ", 0 B/s") || strings.Contains(progress, "downloaded, 0 B/s")
}

func parsedInt(value string) int {
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 0 {
		return 0
	}
	return parsed
}

func firstParsedInt(values ...string) int {
	for _, value := range values {
		if strings.TrimSpace(value) == "" {
			continue
		}
		return parsedInt(value)
	}
	return 0
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
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

func snapshotTaskUpdate(task *Task) *Task {
	return &Task{
		ID: task.ID, Name: task.Name, OutputName: task.OutputName, GID: task.GID,
		Status: task.Status, Progress: task.Progress, Error: task.Error,
		UpdatedAt: task.UpdatedAt, Revision: task.Revision, TotalLength: task.TotalLength,
		RemoteDigest: task.RemoteDigest, RemoteName: task.RemoteName,
	}
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

func taskOutputRootName(folder, ariaPath string) string {
	cleanPath := filepath.Clean(ariaPath)
	relative := cleanPath
	if filepath.IsAbs(cleanPath) {
		cleanFolder, err := filepath.Abs(folder)
		if err == nil {
			relative, err = filepath.Rel(filepath.Clean(cleanFolder), cleanPath)
			if err != nil {
				relative = ""
			}
		}
	}
	if relative != "" && relative != "." && !filepath.IsAbs(relative) && relative != ".." &&
		!strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
		if root := strings.Split(relative, string(os.PathSeparator))[0]; root != "" && root != "." {
			return root
		}
	}
	return filepath.Base(cleanPath)
}

func pathExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil || !os.IsNotExist(err)
}

func removePartialFiles(task *Task, ariaPath string) error {
	if task == nil {
		return fmt.Errorf("missing task metadata for partial-file cleanup")
	}
	folder, err := filepath.Abs(task.Folder)
	if err != nil {
		return fmt.Errorf("resolve download directory: %w", err)
	}
	folder = filepath.Clean(folder)
	target := strings.TrimSpace(ariaPath)
	if target == "" {
		if task.OutputName == "" {
			return fmt.Errorf("cannot identify partial download path")
		}
		target = filepath.Join(folder, task.OutputName)
	}
	target, err = filepath.Abs(target)
	if err != nil {
		return fmt.Errorf("resolve partial download path: %w", err)
	}
	target = filepath.Clean(target)
	relative, err := filepath.Rel(folder, target)
	if err != nil || relative == "." || filepath.IsAbs(relative) || filepath.Dir(relative) != "." {
		return fmt.Errorf("partial download path is outside its download directory")
	}
	if task.OutputName != "" && !samePathName(relative, task.OutputName) {
		return fmt.Errorf("partial download path does not match the task output name")
	}
	for _, path := range []string{target, target + ".aria2"} {
		info, statErr := os.Lstat(path)
		if os.IsNotExist(statErr) {
			continue
		}
		if statErr != nil {
			return fmt.Errorf("inspect partial download %q: %w", filepath.Base(path), statErr)
		}
		if !info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 {
			return fmt.Errorf("refuse to remove non-file partial download %q", filepath.Base(path))
		}
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove partial download %q: %w", filepath.Base(path), err)
		}
	}
	return nil
}

func waitForAriaStop(rpc ariaRPC, gid string) (ariaStatus, error) {
	deadline := time.Now().Add(2 * time.Second)
	for {
		state, err := rpc.status(gid)
		if err != nil {
			if isGIDNotFound(err) {
				return ariaStatus{GID: gid, Status: "removed"}, nil
			}
			return ariaStatus{}, err
		}
		switch state.Status {
		case "removed", "complete", "error":
			return state, nil
		case "active", "waiting", "paused":
		default:
			return ariaStatus{}, fmt.Errorf("unexpected aria2 status %q after removal", state.Status)
		}
		if time.Now().After(deadline) {
			return ariaStatus{}, fmt.Errorf("timed out waiting for aria2 to stop task %s", gid)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func samePathName(left, right string) bool {
	if os.PathSeparator == '\\' {
		return strings.EqualFold(filepath.Clean(left), filepath.Clean(right))
	}
	return filepath.Clean(left) == filepath.Clean(right)
}

func outputNameAvailable(dir, name string) bool {
	for _, path := range []string{filepath.Join(dir, name), filepath.Join(dir, name+".aria2")} {
		if pathExists(path) {
			return false
		}
	}
	return true
}
