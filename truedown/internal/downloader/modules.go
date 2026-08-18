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
// Built-in modules ship with TrueDown but may be installed or removed
// independently from the active resolver registry.
type ModuleInfo struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Version      string   `json:"version"`
	Description  string   `json:"description"`
	Capabilities []string `json:"capabilities"`
	BuiltIn      bool     `json:"builtIn"`
	Installed    bool     `json:"installed"`
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
	mu        sync.RWMutex
	path      string
	ordered   []resolverModule
	byID      map[string]resolverModule
	installed map[string]bool
}

func newModuleRegistry(databasePath string, available ...resolverModule) (*moduleRegistry, error) {
	registry := &moduleRegistry{
		path:      filepath.Join(filepath.Dir(databasePath), "truedown.modules.json"),
		ordered:   append([]resolverModule(nil), available...),
		byID:      make(map[string]resolverModule, len(available)),
		installed: make(map[string]bool, len(available)),
	}
	for _, module := range registry.ordered {
		info := module.info()
		if info.ID == "" || registry.byID[info.ID] != nil {
			return nil, fmt.Errorf("invalid duplicate resolver module %q", info.ID)
		}
		registry.byID[info.ID] = module
		registry.installed[info.ID] = true
	}
	data, err := os.ReadFile(registry.path)
	if os.IsNotExist(err) {
		return registry, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read resolver module settings: %w", err)
	}
	var saved moduleSettingsFile
	if err := json.Unmarshal(data, &saved); err != nil {
		return nil, fmt.Errorf("decode resolver module settings: %w", err)
	}
	if saved.SchemaVersion != 1 {
		return nil, fmt.Errorf("unsupported resolver module settings schema %d", saved.SchemaVersion)
	}
	for id, installed := range saved.Installed {
		if registry.byID[id] != nil {
			registry.installed[id] = installed
		}
	}
	return registry, nil
}

func (registry *moduleRegistry) list() []ModuleInfo {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	infos := make([]ModuleInfo, 0, len(registry.ordered))
	for _, module := range registry.ordered {
		info := module.info()
		info.Capabilities = append([]string(nil), info.Capabilities...)
		info.Installed = registry.installed[info.ID]
		infos = append(infos, info)
	}
	return infos
}

func (registry *moduleRegistry) setInstalled(id string, installed bool) (ModuleInfo, error) {
	id = strings.TrimSpace(id)
	registry.mu.Lock()
	defer registry.mu.Unlock()
	module := registry.byID[id]
	if module == nil {
		return ModuleInfo{}, &ValidationError{Message: fmt.Sprintf("unknown resolver module %q", id)}
	}
	next := make(map[string]bool, len(registry.installed))
	for moduleID, value := range registry.installed {
		next[moduleID] = value
	}
	next[id] = installed
	data, err := json.MarshalIndent(moduleSettingsFile{SchemaVersion: 1, Installed: next}, "", "  ")
	if err != nil {
		return ModuleInfo{}, fmt.Errorf("encode resolver module settings: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(registry.path), 0700); err != nil {
		return ModuleInfo{}, fmt.Errorf("create resolver module settings directory: %w", err)
	}
	if err := os.WriteFile(registry.path, append(data, '\n'), 0600); err != nil {
		return ModuleInfo{}, fmt.Errorf("persist resolver module settings: %w", err)
	}
	registry.installed = next
	info := module.info()
	info.Installed = installed
	return info, nil
}

func (registry *moduleRegistry) installedMatch(link string) resolverModule {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	for _, module := range registry.ordered {
		info := module.info()
		if registry.installed[info.ID] && module.matches(link) {
			return module
		}
	}
	return nil
}

func (registry *moduleRegistry) module(id string) resolverModule {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	return registry.byID[id]
}

func (registry *moduleRegistry) validateOptions(options map[string]json.RawMessage) error {
	if len(options) > len(registry.byID) {
		return &ValidationError{Message: "too many resolver module options"}
	}
	keys := make([]string, 0, len(options))
	for id := range options {
		keys = append(keys, id)
	}
	sort.Strings(keys)
	for _, id := range keys {
		module := registry.module(id)
		if module == nil {
			return &ValidationError{Message: fmt.Sprintf("unknown resolver module option %q", id)}
		}
		if len(options[id]) > 16*1024 {
			return &ValidationError{Message: fmt.Sprintf("resolver module option %q is too large", id)}
		}
		if err := module.validateOptions(options[id]); err != nil {
			return err
		}
	}
	return nil
}

// Modules returns every available built-in resolver and its installation state.
func (m *Manager) Modules() []ModuleInfo {
	return m.modules.list()
}

// SetModuleInstalled installs or removes a built-in resolver from new-link routing.
// Existing tasks retain their module ID and remain resumable after removal.
func (m *Manager) SetModuleInstalled(id string, installed bool) (ModuleInfo, error) {
	return m.modules.setInstalled(id, installed)
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
	if err := m.modules.validateOptions(options); err != nil {
		return ModuleAddResult{}, false, err
	}
	module := m.modules.installedMatch(link)
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
