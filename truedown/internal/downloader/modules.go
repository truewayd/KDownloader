package downloader

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

const (
	DropboxModuleID     = "dropbox"
	GoogleDriveModuleID = "google-drive"
)

// ModuleInfo is the stable dashboard/API description of a resolver module.
// Every module has an embedded baseline; an independently installed package
// may replace only its declarative compatibility profile at runtime.
type ModuleInfo struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	Version         string   `json:"version"`
	BaselineVersion string   `json:"baselineVersion"`
	ReleasedAt      string   `json:"releasedAt"`
	Description     string   `json:"description"`
	Capabilities    []string `json:"capabilities"`
	BuiltIn         bool     `json:"builtIn"`
	Installed       bool     `json:"installed"`
	Source          string   `json:"source"`
	Digest          string   `json:"digest"`
	HotReload       bool     `json:"hotReload"`
	UpdateError     string   `json:"updateError,omitempty"`
}

type ModuleInstallRequest struct {
	ID        string `json:"id"`
	Installed *bool  `json:"installed"`
}

type moduleResolveRequest struct {
	Link         string
	Name         string
	Folder       string
	Headers      map[string]string
	DownloadPage string
	QueueID      int
	Opts         Aria2Opts
	Options      json.RawMessage
}

type ModuleAddResult struct {
	ModuleID   string
	Tasks      []*Task
	Duplicates int
	Filtered   int
	Collection bool
}

type remoteMetadata struct {
	URL         string
	Name        string
	Digest      string
	Length      int64
	LengthKnown bool
}

type modulePreparation struct {
	Link     string
	Headers  map[string]string
	ProxyURL string
	Metadata remoteMetadata
}

type resolverModule interface {
	info() ModuleInfo
	matches(string) bool
	validateOptions(json.RawMessage) error
	resolve(context.Context, *Manager, moduleResolveRequest) (ModuleAddResult, bool, error)
	prepare(context.Context, *Manager, *Task) (modulePreparation, error)
	supportsPartialResume(string) bool
}

type moduleSettingsFile struct {
	SchemaVersion int             `json:"schemaVersion"`
	Installed     map[string]bool `json:"installed"`
}

type moduleRegistry struct {
	mu           sync.RWMutex
	writeMu      sync.Mutex
	settingsPath string
	packagesDir  string
	ordered      []string
	factories    map[string]resolverComponentFactory
	baseline     map[string]loadedComponent
	active       map[string]loadedComponent
	installed    map[string]bool
	updateErrors map[string]string
}

func newModuleRegistry(databasePath string) (*moduleRegistry, error) {
	registry := &moduleRegistry{
		settingsPath: filepath.Join(filepath.Dir(databasePath), "truedown.modules.json"),
		packagesDir:  filepath.Join(filepath.Dir(databasePath), "modules"),
		factories:    make(map[string]resolverComponentFactory),
		baseline:     make(map[string]loadedComponent),
		active:       make(map[string]loadedComponent),
		installed:    make(map[string]bool),
		updateErrors: make(map[string]string),
	}
	for _, factory := range resolverComponentFactories() {
		if factory.id == "" || registry.factories[factory.id].id != "" {
			return nil, fmt.Errorf("invalid duplicate resolver component %q", factory.id)
		}
		baseline, err := loadBaselineComponent(factory)
		if err != nil {
			return nil, err
		}
		registry.ordered = append(registry.ordered, factory.id)
		registry.factories[factory.id] = factory
		registry.baseline[factory.id] = baseline
		registry.active[factory.id] = baseline
		registry.installed[factory.id] = true

		raw, err := readComponentPackage(registry.packagePath(factory.id))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			registry.updateErrors[factory.id] = fmt.Sprintf("read installed update: %v", err)
			continue
		}
		updated, err := decodeComponent(factory, raw, "updated")
		if err != nil {
			registry.updateErrors[factory.id] = err.Error()
			continue
		}
		if compareComponentVersions(updated.packageInfo.Version, baseline.packageInfo.Version) <= 0 {
			registry.updateErrors[factory.id] = "installed update is not newer than the embedded baseline"
			continue
		}
		registry.active[factory.id] = updated
	}
	if err := registry.loadSettings(); err != nil {
		return nil, err
	}
	return registry, nil
}

func (registry *moduleRegistry) loadSettings() error {
	data, err := readComponentPackage(registry.settingsPath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read resolver module settings: %w", err)
	}
	var saved moduleSettingsFile
	if err := json.Unmarshal(data, &saved); err != nil {
		return fmt.Errorf("decode resolver module settings: %w", err)
	}
	if saved.SchemaVersion != 1 {
		return fmt.Errorf("unsupported resolver module settings schema %d", saved.SchemaVersion)
	}
	for id, installed := range saved.Installed {
		if registry.factories[id].id != "" {
			registry.installed[id] = installed
		}
	}
	return nil
}

func (registry *moduleRegistry) packagePath(id string) string {
	return filepath.Join(registry.packagesDir, id+".json")
}

func (registry *moduleRegistry) list() []ModuleInfo {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	infos := make([]ModuleInfo, 0, len(registry.ordered))
	for _, id := range registry.ordered {
		infos = append(infos, registry.infoLocked(id, registry.active[id]))
	}
	return infos
}

func (registry *moduleRegistry) setInstalled(id string, installed bool) (ModuleInfo, error) {
	id = strings.TrimSpace(id)
	registry.writeMu.Lock()
	defer registry.writeMu.Unlock()

	registry.mu.RLock()
	_, exists := registry.active[id]
	if !exists {
		registry.mu.RUnlock()
		return ModuleInfo{}, &ValidationError{Message: fmt.Sprintf("unknown resolver module %q", id)}
	}
	next := make(map[string]bool, len(registry.installed))
	for moduleID, value := range registry.installed {
		next[moduleID] = value
	}
	registry.mu.RUnlock()
	next[id] = installed
	data, err := json.MarshalIndent(moduleSettingsFile{SchemaVersion: 1, Installed: next}, "", "  ")
	if err != nil {
		return ModuleInfo{}, fmt.Errorf("encode resolver module settings: %w", err)
	}
	if err := writeComponentPackage(registry.settingsPath, append(data, '\n')); err != nil {
		return ModuleInfo{}, fmt.Errorf("persist resolver module settings: %w", err)
	}
	registry.mu.Lock()
	registry.installed = next
	info := registry.infoLocked(id, registry.active[id])
	info.Installed = installed
	registry.mu.Unlock()
	return info, nil
}

func (registry *moduleRegistry) installPackage(raw json.RawMessage) (ModuleInfo, error) {
	if len(raw) == 0 || len(raw) > maxModulePackageBytes {
		return ModuleInfo{}, &ValidationError{Message: "resolver component package must be between 1 byte and 64 KiB"}
	}
	var identity struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &identity); err != nil {
		return ModuleInfo{}, &ValidationError{Message: "invalid resolver component package"}
	}
	id := strings.TrimSpace(identity.ID)
	registry.writeMu.Lock()
	defer registry.writeMu.Unlock()

	registry.mu.RLock()
	factory, exists := registry.factories[id]
	if !exists {
		registry.mu.RUnlock()
		return ModuleInfo{}, &ValidationError{Message: fmt.Sprintf("unknown resolver component %q", id)}
	}
	baselineVersion := registry.baseline[id].packageInfo.Version
	current := registry.active[id]
	registry.mu.RUnlock()
	updated, err := decodeComponent(factory, raw, "updated")
	if err != nil {
		return ModuleInfo{}, err
	}
	if compareComponentVersions(updated.packageInfo.Version, baselineVersion) <= 0 {
		return ModuleInfo{}, &ValidationError{Message: fmt.Sprintf("resolver component update must be newer than baseline %s", baselineVersion)}
	}
	if current.source == "updated" &&
		compareComponentVersions(updated.packageInfo.Version, current.packageInfo.Version) <= 0 {
		return ModuleInfo{}, &ValidationError{Message: fmt.Sprintf("resolver component update must be newer than active version %s", current.packageInfo.Version)}
	}
	data, err := marshalComponentPackage(updated.packageInfo)
	if err != nil {
		return ModuleInfo{}, fmt.Errorf("encode resolver component update: %w", err)
	}
	if err := writeComponentPackage(registry.packagePath(id), data); err != nil {
		return ModuleInfo{}, fmt.Errorf("persist resolver component update: %w", err)
	}
	registry.mu.Lock()
	registry.active[id] = updated
	delete(registry.updateErrors, id)
	info := registry.infoLocked(id, updated)
	registry.mu.Unlock()
	return info, nil
}

func (registry *moduleRegistry) resetPackage(id string) (ModuleInfo, error) {
	id = strings.TrimSpace(id)
	registry.writeMu.Lock()
	defer registry.writeMu.Unlock()

	registry.mu.RLock()
	baseline, exists := registry.baseline[id]
	registry.mu.RUnlock()
	if !exists {
		return ModuleInfo{}, &ValidationError{Message: fmt.Sprintf("unknown resolver component %q", id)}
	}
	packagePath := registry.packagePath(id)
	if err := os.Remove(packagePath + ".bak"); err != nil && !os.IsNotExist(err) {
		return ModuleInfo{}, fmt.Errorf("remove resolver component update backup: %w", err)
	}
	if err := os.Remove(packagePath); err != nil && !os.IsNotExist(err) {
		return ModuleInfo{}, fmt.Errorf("remove resolver component update: %w", err)
	}
	registry.mu.Lock()
	registry.active[id] = baseline
	delete(registry.updateErrors, id)
	info := registry.infoLocked(id, baseline)
	registry.mu.Unlock()
	return info, nil
}

func (registry *moduleRegistry) infoLocked(id string, component loadedComponent) ModuleInfo {
	info := component.module.info()
	info.Capabilities = append([]string(nil), info.Capabilities...)
	info.Version = component.packageInfo.Version
	info.BaselineVersion = registry.baseline[id].packageInfo.Version
	info.ReleasedAt = component.packageInfo.ReleasedAt
	info.BuiltIn = true
	info.Installed = registry.installed[id]
	info.Source = component.source
	info.Digest = component.digest
	info.HotReload = true
	info.UpdateError = registry.updateErrors[id]
	return info
}

func (registry *moduleRegistry) installedMatch(link string) resolverModule {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	for _, id := range registry.ordered {
		component := registry.active[id]
		if registry.installed[id] && component.module.matches(link) {
			return component.module
		}
	}
	return nil
}

func (registry *moduleRegistry) module(id string) resolverModule {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	return registry.active[id].module
}

func (registry *moduleRegistry) selectModule(link string, options map[string]json.RawMessage) (resolverModule, error) {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	if len(options) > len(registry.active) {
		return nil, &ValidationError{Message: "too many resolver module options"}
	}
	keys := make([]string, 0, len(options))
	for id := range options {
		keys = append(keys, id)
	}
	sort.Strings(keys)
	for _, id := range keys {
		component, exists := registry.active[id]
		if !exists {
			return nil, &ValidationError{Message: fmt.Sprintf("unknown resolver module option %q", id)}
		}
		if len(options[id]) > 16*1024 {
			return nil, &ValidationError{Message: fmt.Sprintf("resolver module option %q is too large", id)}
		}
		if err := component.module.validateOptions(options[id]); err != nil {
			return nil, err
		}
	}
	for _, id := range registry.ordered {
		component := registry.active[id]
		if registry.installed[id] && component.module.matches(link) {
			return component.module, nil
		}
	}
	return nil, nil
}

// Modules returns every resolver, its embedded baseline, and active package.
func (m *Manager) Modules() []ModuleInfo {
	return m.modules.list()
}

// SetModuleInstalled changes only new-link routing. Existing tasks retain their
// module ID and continue to use the current active component snapshot.
func (m *Manager) SetModuleInstalled(id string, installed bool) (ModuleInfo, error) {
	return m.modules.setInstalled(id, installed)
}

// InstallModulePackage validates, persists, and hot-activates one declarative
// component. In-flight calls retain their immutable previous module snapshot.
func (m *Manager) InstallModulePackage(raw json.RawMessage) (ModuleInfo, error) {
	return m.modules.installPackage(raw)
}

// ResetModulePackage removes an independent update and immediately restores
// the baseline embedded in the current TrueDown binary.
func (m *Manager) ResetModulePackage(id string) (ModuleInfo, error) {
	return m.modules.resetPackage(id)
}

// AddWithModules lets the first installed matching module resolve the submitted
// link. It returns handled=false for ordinary HTTP(S) links.
func (m *Manager) AddWithModules(
	ctx context.Context,
	link, name, folder string,
	headers map[string]string,
	downloadPage string,
	queueID int,
	opts Aria2Opts,
	options map[string]json.RawMessage,
) (ModuleAddResult, bool, error) {
	module, err := m.modules.selectModule(link, options)
	if err != nil {
		return ModuleAddResult{}, false, err
	}
	if module == nil {
		return ModuleAddResult{}, false, nil
	}
	info := module.info()
	return module.resolve(ctx, m, moduleResolveRequest{
		Link: link, Name: name, Folder: folder, Headers: headers,
		DownloadPage: downloadPage, QueueID: queueID, Opts: opts,
		Options: options[info.ID],
	})
}

func (m *Manager) installedModuleID(link string) string {
	if module := m.modules.installedMatch(link); module != nil {
		return module.info().ID
	}
	return ""
}
