package systemupdate

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"truedown/internal/safefile"
)

const (
	EngineStable = "stable"
	EngineNext   = "next"

	stateSchemaVersion = 1
	maxEngineBytes     = 64 * 1024 * 1024

	defaultTrueDownReleasesURL = "https://api.github.com/repos/truewayd/KDownloader/releases?per_page=50"
	defaultNextReleaseURL      = "https://api.github.com/repos/AnInsomniacy/aria2-next/releases/latest"
)

var (
	canonicalVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)
	stableVersionPattern    = regexp.MustCompile(`(?mi)^aria2 version ([0-9]+\.[0-9]+\.[0-9]+)\s*$`)
	nextVersionPattern      = regexp.MustCompile(`(?mi)^aria2 next version ([0-9]+\.[0-9]+\.[0-9]+)\s*$`)
	updateHelperPattern     = regexp.MustCompile(`^TrueDown-updater-[0-9]+\.exe$`)
)

type Options struct {
	BaseDir          string
	DataDir          string
	StableEnginePath string
	CurrentVersion   string
	CurrentBuild     int64
	CurrentCommit    string

	HTTPClient            *http.Client
	TrueDownReleasesURL   string
	NextReleaseURL        string
	AllowInsecureLoopback bool
	InspectEngine         func(string) (kind, version string, err error)
	Now                   func() time.Time
}

type Settings struct {
	AutoUpdateTrueDown bool `json:"autoUpdateTrueDown"`
}

type TrueDownStatus struct {
	Version          string     `json:"version"`
	Build            int64      `json:"build"`
	Commit           string     `json:"commit,omitempty"`
	Supported        bool       `json:"supported"`
	AutoUpdate       bool       `json:"autoUpdate"`
	UpdateAvailable  bool       `json:"updateAvailable"`
	AvailableVersion string     `json:"availableVersion,omitempty"`
	AvailableBuild   int64      `json:"availableBuild,omitempty"`
	PendingVersion   string     `json:"pendingVersion,omitempty"`
	PendingBuild     int64      `json:"pendingBuild,omitempty"`
	RestartRequired  bool       `json:"restartRequired"`
	LastCheckedAt    *time.Time `json:"lastCheckedAt,omitempty"`
}

type EngineStatus struct {
	Preference           string `json:"preference"`
	Active               string `json:"active"`
	ActiveVersion        string `json:"activeVersion,omitempty"`
	StableVersion        string `json:"stableVersion,omitempty"`
	NextInstalled        bool   `json:"nextInstalled"`
	NextInstalledVersion string `json:"nextInstalledVersion,omitempty"`
	NextAvailableVersion string `json:"nextAvailableVersion,omitempty"`
	RestartRequired      bool   `json:"restartRequired"`
	ManualUpdatesOnly    bool   `json:"manualUpdatesOnly"`
}

type Snapshot struct {
	TrueDown TrueDownStatus `json:"trueDown"`
	Engine   EngineStatus   `json:"engine"`
	Busy     string         `json:"busy,omitempty"`
	Error    string         `json:"error,omitempty"`
}

type installedEngine struct {
	Version string `json:"version"`
	File    string `json:"file"`
	SHA256  string `json:"sha256"`
}

type pendingAppUpdate struct {
	Version string `json:"version"`
	Build   int64  `json:"build"`
	File    string `json:"file"`
	SHA256  string `json:"sha256"`
}

type persistedState struct {
	SchemaVersion      int               `json:"schemaVersion"`
	AutoUpdateTrueDown bool              `json:"autoUpdateTrueDown"`
	EnginePreference   string            `json:"enginePreference"`
	NextEngine         *installedEngine  `json:"nextEngine,omitempty"`
	PendingUpdate      *pendingAppUpdate `json:"pendingUpdate,omitempty"`
	LastCheckedAt      time.Time         `json:"lastCheckedAt,omitzero"`
	LastUpdateError    string            `json:"lastUpdateError,omitempty"`
}

type activeEngine struct {
	Kind    string
	Version string
	Path    string
	File    string
}

// EngineSpec identifies one verified download-engine executable. Paths are
// consumed only inside TrueDown and are never serialized by the HTTP API.
type EngineSpec struct {
	Kind    string
	Version string
	Path    string
	File    string
}

type availableAppUpdate struct {
	Version      string
	Build        int64
	ManifestURL  string
	ManifestSize int64
	ArchiveURL   string
	ArchiveSize  int64
	ArchiveName  string
	ReleaseURL   string
	PublishedAt  time.Time
}

type availableNextUpdate struct {
	Version      string
	BinaryName   string
	BinaryURL    string
	BinarySize   int64
	ChecksumName string
	ChecksumURL  string
}

type Manager struct {
	mu sync.RWMutex

	baseDir          string
	dataDir          string
	statePath        string
	stableEnginePath string
	currentExe       string
	currentVersion   string
	currentBuild     int64
	currentCommit    string

	client                *http.Client
	trueDownReleasesURL   string
	nextReleaseURL        string
	allowInsecureLoopback bool
	inspectEngine         func(string) (string, string, error)
	now                   func() time.Time

	state         persistedState
	active        activeEngine
	stableVersion string
	availableApp  *availableAppUpdate
	availableNext *availableNextUpdate
	busy          string
	lastError     string
	restart       func() error
	applyLaunched bool
}

func New(options Options) (*Manager, error) {
	baseDir, err := filepath.Abs(options.BaseDir)
	if err != nil {
		return nil, fmt.Errorf("resolve TrueDown directory: %w", err)
	}
	dataDir, err := filepath.Abs(options.DataDir)
	if err != nil {
		return nil, fmt.Errorf("resolve TrueDown data directory: %w", err)
	}
	stablePath, err := filepath.Abs(options.StableEnginePath)
	if err != nil {
		return nil, fmt.Errorf("resolve built-in aria2 path: %w", err)
	}
	currentExe, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("resolve TrueDown executable: %w", err)
	}
	currentExe, err = filepath.Abs(currentExe)
	if err != nil {
		return nil, fmt.Errorf("resolve TrueDown executable: %w", err)
	}
	client := options.HTTPClient
	if client == nil {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		client = &http.Client{
			Transport: transport,
			Timeout:   45 * time.Second,
		}
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	inspect := options.InspectEngine
	if inspect == nil {
		inspect = inspectEngineBinary
	}
	trueDownURL := strings.TrimSpace(options.TrueDownReleasesURL)
	if trueDownURL == "" {
		trueDownURL = defaultTrueDownReleasesURL
	}
	nextURL := strings.TrimSpace(options.NextReleaseURL)
	if nextURL == "" {
		nextURL = defaultNextReleaseURL
	}
	manager := &Manager{
		baseDir:               filepath.Clean(baseDir),
		dataDir:               filepath.Clean(dataDir),
		statePath:             filepath.Join(dataDir, "truedown.updates.json"),
		stableEnginePath:      filepath.Clean(stablePath),
		currentExe:            filepath.Clean(currentExe),
		currentVersion:        strings.TrimSpace(options.CurrentVersion),
		currentBuild:          options.CurrentBuild,
		currentCommit:         strings.TrimSpace(options.CurrentCommit),
		client:                client,
		trueDownReleasesURL:   trueDownURL,
		nextReleaseURL:        nextURL,
		allowInsecureLoopback: options.AllowInsecureLoopback,
		inspectEngine:         inspect,
		now:                   now,
		state: persistedState{
			SchemaVersion:      stateSchemaVersion,
			AutoUpdateTrueDown: true,
			EnginePreference:   EngineStable,
		},
	}
	clientCopy := *client
	clientCopy.CheckRedirect = manager.checkRedirect
	manager.client = &clientCopy
	if manager.currentVersion == "" {
		manager.currentVersion = "dev"
	}
	if err := manager.loadState(); err != nil {
		manager.lastError = fmt.Sprintf("ignored invalid update settings and used the built-in stable engine: %v", err)
		invalidPath := fmt.Sprintf("%s.invalid-%d", manager.statePath, manager.now().UnixNano())
		if renameErr := os.Rename(manager.statePath, invalidPath); renameErr != nil && !os.IsNotExist(renameErr) {
			manager.lastError += fmt.Sprintf("; could not preserve the invalid file: %v", renameErr)
		}
	}
	manager.resolveActiveEngine()
	return manager, nil
}

func (m *Manager) EnginePath() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.active.Path
}

func (m *Manager) ActiveEngine() EngineSpec {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return engineSpec(m.active)
}

// PreferredEngine resolves and revalidates the saved engine preference. It is
// used immediately before a live engine transition so a replaced or damaged
// managed binary cannot be started merely because it was valid at launch.
func (m *Manager) PreferredEngine() (EngineSpec, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	resolved, err := m.resolveEngineLocked(m.state.EnginePreference)
	if err != nil {
		return EngineSpec{}, err
	}
	return engineSpec(resolved), nil
}

// ActivateEngine updates the process-local active engine after the downloader
// runtime has successfully started the exact verified executable.
func (m *Manager) ActivateEngine(spec EngineSpec) (Snapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	resolved, err := m.resolveEngineLocked(spec.Kind)
	if err != nil {
		return m.snapshotLocked(), err
	}
	if !sameEngineSpec(spec, engineSpec(resolved)) {
		return m.snapshotLocked(), fmt.Errorf("active download engine does not match the verified selection")
	}
	m.active = resolved
	m.lastError = ""
	return m.snapshotLocked(), nil
}

func (m *Manager) RecordEngineError(err error) Snapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err == nil {
		m.lastError = ""
		return m.snapshotLocked()
	}
	m.lastError = truncate(err.Error(), 1024)
	return m.snapshotLocked()
}

// FallbackToStable keeps the saved NEXT preference but records that the
// selected engine could not start in this process. A later restart may retry
// NEXT after it has been updated or repaired.
func (m *Manager) FallbackToStable(reason error) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.active = activeEngine{
		Kind:    EngineStable,
		Version: m.stableVersion,
		Path:    m.stableEnginePath,
		File:    filepath.Base(m.stableEnginePath),
	}
	m.lastError = "Aria2 Next could not start; using the built-in stable engine"
	if reason != nil {
		m.lastError += ": " + truncate(reason.Error(), 1024)
	}
	return m.active.Path
}

func (m *Manager) SetRestartCallback(callback func() error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.restart = callback
}

func (m *Manager) Snapshot() Snapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.snapshotLocked()
}

func (m *Manager) snapshotLocked() Snapshot {
	status := Snapshot{
		TrueDown: TrueDownStatus{
			Version:    m.currentVersion,
			Build:      m.currentBuild,
			Commit:     m.currentCommit,
			Supported:  runtime.GOOS == "windows" && m.currentBuild > 0,
			AutoUpdate: m.state.AutoUpdateTrueDown,
		},
		Engine: EngineStatus{
			Preference:        m.state.EnginePreference,
			Active:            m.active.Kind,
			ActiveVersion:     m.active.Version,
			StableVersion:     m.stableVersion,
			ManualUpdatesOnly: true,
		},
		Busy:  m.busy,
		Error: firstNonEmpty(m.lastError, m.state.LastUpdateError),
	}
	if !m.state.LastCheckedAt.IsZero() {
		lastChecked := m.state.LastCheckedAt
		status.TrueDown.LastCheckedAt = &lastChecked
	}
	if m.availableApp != nil && m.availableApp.Build > m.currentBuild {
		status.TrueDown.UpdateAvailable = true
		status.TrueDown.AvailableVersion = m.availableApp.Version
		status.TrueDown.AvailableBuild = m.availableApp.Build
	}
	if pending := m.state.PendingUpdate; pending != nil && pending.Build > m.currentBuild {
		status.TrueDown.PendingVersion = pending.Version
		status.TrueDown.PendingBuild = pending.Build
		status.TrueDown.RestartRequired = true
	}
	if next := m.state.NextEngine; next != nil {
		status.Engine.NextInstalled = true
		status.Engine.NextInstalledVersion = next.Version
	}
	if m.availableNext != nil {
		status.Engine.NextAvailableVersion = m.availableNext.Version
	}
	status.Engine.RestartRequired = m.engineRestartRequiredLocked()
	return status
}

func (m *Manager) engineRestartRequiredLocked() bool {
	if m.state.EnginePreference != m.active.Kind {
		return true
	}
	if m.state.EnginePreference == EngineNext && m.state.NextEngine != nil {
		return m.active.File != m.state.NextEngine.File
	}
	return false
}

func (m *Manager) SetSettings(settings Settings) (Snapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.state.AutoUpdateTrueDown = settings.AutoUpdateTrueDown
	if err := m.persistLocked(); err != nil {
		return Snapshot{}, err
	}
	return m.snapshotLocked(), nil
}

func (m *Manager) SelectEngine(engine string) (Snapshot, error) {
	engine = strings.ToLower(strings.TrimSpace(engine))
	if engine != EngineStable && engine != EngineNext {
		return Snapshot{}, fmt.Errorf("engine must be stable or next")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.busy != "" {
		return Snapshot{}, fmt.Errorf("update operation %q is still running", m.busy)
	}
	if engine == EngineNext && m.state.NextEngine == nil {
		return Snapshot{}, fmt.Errorf("install an Aria2 Next engine before selecting it")
	}
	m.state.EnginePreference = engine
	m.state.LastUpdateError = ""
	m.lastError = ""
	if err := m.persistLocked(); err != nil {
		return Snapshot{}, err
	}
	return m.snapshotLocked(), nil
}

func (m *Manager) RequestRestart() error {
	m.mu.RLock()
	pending := m.state.PendingUpdate != nil && m.state.PendingUpdate.Build > m.currentBuild
	restart := m.restart
	m.mu.RUnlock()
	if !pending {
		return fmt.Errorf("no staged TrueDown update is ready")
	}
	if restart == nil {
		return fmt.Errorf("restart is unavailable")
	}
	return restart()
}

func (m *Manager) HasPendingUpdate() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.state.PendingUpdate != nil && m.state.PendingUpdate.Build > m.currentBuild
}

func (m *Manager) begin(operation string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.busy != "" {
		return fmt.Errorf("update operation %q is still running", m.busy)
	}
	m.busy = operation
	m.lastError = ""
	m.state.LastUpdateError = ""
	return nil
}

func (m *Manager) finish(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.busy = ""
	if err != nil {
		m.lastError = truncate(err.Error(), 1024)
		m.state.LastUpdateError = m.lastError
	} else {
		m.state.LastUpdateError = ""
	}
	if persistErr := m.persistLocked(); persistErr != nil {
		m.lastError = firstNonEmpty(m.lastError, fmt.Sprintf("persist update result: %v", persistErr))
	}
}

func (m *Manager) resolveActiveEngine() {
	kind, version, err := m.inspectEngine(m.stableEnginePath)
	if err == nil && kind == EngineStable {
		m.stableVersion = version
	}
	m.active = activeEngine{
		Kind:    EngineStable,
		Version: m.stableVersion,
		Path:    m.stableEnginePath,
		File:    filepath.Base(m.stableEnginePath),
	}
	if m.state.EnginePreference != EngineNext || m.state.NextEngine == nil {
		return
	}
	nextPath, err := m.installedEnginePath(m.state.NextEngine)
	if err != nil {
		m.lastError = err.Error()
		return
	}
	digest, size, err := hashFile(nextPath, maxEngineBytes)
	if err != nil {
		m.lastError = fmt.Sprintf("validate installed Aria2 Next: %v", err)
		return
	}
	if size <= 0 || !strings.EqualFold(digest, m.state.NextEngine.SHA256) {
		m.lastError = "installed Aria2 Next failed its SHA-256 check; using built-in aria2"
		return
	}
	kind, version, err = m.inspectEngine(nextPath)
	if err != nil || kind != EngineNext || version != m.state.NextEngine.Version {
		m.lastError = "installed Aria2 Next failed its version check; using built-in aria2"
		return
	}
	m.active = activeEngine{Kind: EngineNext, Version: version, Path: nextPath, File: m.state.NextEngine.File}
}

func (m *Manager) resolveEngineLocked(kind string) (activeEngine, error) {
	switch kind {
	case EngineStable:
		resolvedKind, version, err := m.inspectEngine(m.stableEnginePath)
		if err != nil {
			return activeEngine{}, fmt.Errorf("validate built-in aria2: %w", err)
		}
		if resolvedKind != EngineStable {
			return activeEngine{}, fmt.Errorf("built-in aria2 has unexpected engine kind %q", resolvedKind)
		}
		return activeEngine{
			Kind: EngineStable, Version: version, Path: m.stableEnginePath,
			File: filepath.Base(m.stableEnginePath),
		}, nil
	case EngineNext:
		if m.state.NextEngine == nil {
			return activeEngine{}, fmt.Errorf("install an Aria2 Next engine before selecting it")
		}
		nextPath, err := m.installedEnginePath(m.state.NextEngine)
		if err != nil {
			return activeEngine{}, err
		}
		digest, size, err := hashFile(nextPath, maxEngineBytes)
		if err != nil {
			return activeEngine{}, fmt.Errorf("validate installed Aria2 Next: %w", err)
		}
		if size <= 0 || !strings.EqualFold(digest, m.state.NextEngine.SHA256) {
			return activeEngine{}, fmt.Errorf("installed Aria2 Next failed its SHA-256 check")
		}
		resolvedKind, version, err := m.inspectEngine(nextPath)
		if err != nil {
			return activeEngine{}, fmt.Errorf("validate installed Aria2 Next: %w", err)
		}
		if resolvedKind != EngineNext || version != m.state.NextEngine.Version {
			return activeEngine{}, fmt.Errorf("installed Aria2 Next failed its version check")
		}
		return activeEngine{
			Kind: EngineNext, Version: version, Path: nextPath, File: m.state.NextEngine.File,
		}, nil
	default:
		return activeEngine{}, fmt.Errorf("engine must be stable or next")
	}
}

func engineSpec(engine activeEngine) EngineSpec {
	return EngineSpec{Kind: engine.Kind, Version: engine.Version, Path: engine.Path, File: engine.File}
}

func sameEngineSpec(left, right EngineSpec) bool {
	return left.Kind == right.Kind && left.Version == right.Version && left.File == right.File &&
		strings.EqualFold(filepath.Clean(left.Path), filepath.Clean(right.Path))
}

func (m *Manager) installedEnginePath(engine *installedEngine) (string, error) {
	if engine == nil || !canonicalVersionPattern.MatchString(engine.Version) {
		return "", fmt.Errorf("invalid installed Aria2 Next metadata")
	}
	if filepath.Base(engine.File) != engine.File || engine.File == "." || engine.File == "" {
		return "", fmt.Errorf("invalid installed Aria2 Next filename")
	}
	path := filepath.Clean(filepath.Join(m.dataDir, "engines", engine.File))
	root := filepath.Clean(filepath.Join(m.dataDir, "engines")) + string(os.PathSeparator)
	if !strings.HasPrefix(strings.ToLower(path), strings.ToLower(root)) {
		return "", fmt.Errorf("installed Aria2 Next path escapes the engines directory")
	}
	return path, nil
}

func (m *Manager) loadState() error {
	data, err := safefile.ReadFile(m.statePath, 256*1024)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read update settings: %w", err)
	}
	data, err = requireJSONObject(data, "update settings")
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var state persistedState
	if err := decoder.Decode(&state); err != nil {
		return fmt.Errorf("decode update settings: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return fmt.Errorf("update settings must contain one JSON object")
	}
	if state.SchemaVersion != stateSchemaVersion {
		return fmt.Errorf("unsupported update settings schema %d", state.SchemaVersion)
	}
	if state.EnginePreference != EngineStable && state.EnginePreference != EngineNext {
		return fmt.Errorf("invalid saved engine preference %q", state.EnginePreference)
	}
	if state.NextEngine != nil {
		if _, err := m.installedEnginePath(state.NextEngine); err != nil {
			return err
		}
		if normalizeSHA256(state.NextEngine.SHA256) == "" {
			return fmt.Errorf("invalid installed Aria2 Next SHA-256")
		}
		state.NextEngine.SHA256 = strings.ToLower(state.NextEngine.SHA256)
	}
	if state.PendingUpdate != nil {
		if filepath.Base(state.PendingUpdate.File) != state.PendingUpdate.File || state.PendingUpdate.Build <= 0 || normalizeSHA256(state.PendingUpdate.SHA256) == "" {
			return fmt.Errorf("invalid pending TrueDown update metadata")
		}
		state.PendingUpdate.SHA256 = strings.ToLower(state.PendingUpdate.SHA256)
		if state.PendingUpdate.Build <= m.currentBuild {
			state.PendingUpdate = nil
		}
	}
	m.state = state
	return nil
}

func requireJSONObject(data []byte, description string) ([]byte, error) {
	data = bytes.TrimSpace(data)
	if len(data) == 0 || data[0] != '{' {
		return nil, fmt.Errorf("%s must contain one JSON object", description)
	}
	return data, nil
}

func (m *Manager) persistLocked() error {
	m.state.SchemaVersion = stateSchemaVersion
	data, err := json.MarshalIndent(m.state, "", "  ")
	if err != nil {
		return fmt.Errorf("encode update settings: %w", err)
	}
	if err := writeAtomicFile(m.statePath, append(data, '\n'), 0600); err != nil {
		return fmt.Errorf("persist update settings: %w", err)
	}
	return nil
}

func inspectEngineBinary(path string) (string, string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "--version")
	var output limitedBuffer
	output.limit = 128 * 1024
	cmd.Stdout = &output
	cmd.Stderr = &output
	if err := cmd.Run(); err != nil {
		return "", "", fmt.Errorf("run engine version check: %w", err)
	}
	if match := nextVersionPattern.FindSubmatch(output.Bytes()); len(match) == 2 {
		return EngineNext, string(match[1]), nil
	}
	if match := stableVersionPattern.FindSubmatch(output.Bytes()); len(match) == 2 {
		return EngineStable, string(match[1]), nil
	}
	return "", "", fmt.Errorf("unrecognized download-engine version output")
}

type limitedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *limitedBuffer) Write(data []byte) (int, error) {
	original := len(data)
	remaining := b.limit - b.Len()
	if remaining > 0 {
		if len(data) > remaining {
			data = data[:remaining]
		}
		_, _ = b.Buffer.Write(data)
	}
	return original, nil
}

func hashFile(path string, maximum int64) (string, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", 0, err
	}
	if !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > maximum {
		return "", 0, fmt.Errorf("file size is outside the allowed range")
	}
	hash := sha256.New()
	written, err := io.Copy(hash, io.LimitReader(file, maximum+1))
	if err != nil {
		return "", 0, err
	}
	if written != info.Size() {
		return "", 0, fmt.Errorf("file changed while hashing")
	}
	return hex.EncodeToString(hash.Sum(nil)), written, nil
}

func writeAtomicFile(path string, data []byte, mode os.FileMode) error {
	return safefile.WriteFile(path, data, mode)
}

func normalizeSHA256(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if len(value) != sha256.Size*2 {
		return ""
	}
	if _, err := hex.DecodeString(value); err != nil {
		return ""
	}
	return value
}

func parseBuild(value string) (int64, bool) {
	value = strings.TrimPrefix(strings.TrimSpace(value), "truedown-build-")
	build, err := strconv.ParseInt(value, 10, 64)
	return build, err == nil && build > 0
}

func isLoopbackURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return loopbackHost(parsed.Hostname())
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func truncate(value string, maximum int) string {
	if len(value) <= maximum {
		return value
	}
	return value[:maximum]
}
