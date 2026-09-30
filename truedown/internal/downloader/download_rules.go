package downloader

import (
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"
	"sync"
)

var defaultExcludedExtensions = []string{
	".psd", ".clip", ".sai", ".sai2", ".kra", ".xcf", ".procreate", ".afphoto", ".afdesign", ".blend",
}

const (
	DropboxModeDirect     = "direct"
	DropboxModeExpand     = "expand"
	DropboxFilterProject  = "project"
	DropboxFilterOff      = "off"
	DropboxFilterCustom   = "custom"
	maxDownloadRulesBytes = 16 * 1024
)

// DownloadRules stores the default Dropbox folder behavior and the optional
// suffix filter used only while a shared folder is expanded.
type DownloadRules struct {
	Enabled            bool     `json:"enabled"`
	ExcludedExtensions []string `json:"excludedExtensions"`
	DropboxMode        string   `json:"dropboxMode"`
	FilterMode         string   `json:"filterMode"`
}

// DownloadRulesUpdate preserves the current Dropbox mode when older clients
// post only filter fields to the shared settings endpoint.
type DownloadRulesUpdate struct {
	Enabled            bool     `json:"enabled"`
	ExcludedExtensions []string `json:"excludedExtensions"`
	DropboxMode        *string  `json:"dropboxMode"`
	FilterMode         *string  `json:"filterMode"`
}

type downloadRulesStore struct {
	mu    sync.RWMutex
	path  string
	rules DownloadRules
}

func newDownloadRulesStoreAt(path string) (*downloadRulesStore, error) {
	store := &downloadRulesStore{
		path:  path,
		rules: defaultDownloadRules(),
	}
	var rules DownloadRules
	err := readStrictJSONFile(store.path, maxDownloadRulesBytes, &rules)
	if os.IsNotExist(err) {
		return store, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read download rules: %w", err)
	}
	normalized, err := normalizeDownloadRules(rules)
	if err != nil {
		return nil, fmt.Errorf("validate download rules: %w", err)
	}
	store.rules = normalized
	return store, nil
}

func defaultDownloadRules() DownloadRules {
	return DownloadRules{
		Enabled:     true,
		FilterMode:  DropboxFilterProject,
		DropboxMode: DropboxModeDirect,
	}
}

func normalizeDownloadRules(rules DownloadRules) (DownloadRules, error) {
	if len(rules.ExcludedExtensions) > 128 {
		return DownloadRules{}, &ValidationError{Message: "too many excluded file extensions"}
	}
	normalized := DownloadRules{
		Enabled:            rules.Enabled,
		ExcludedExtensions: make([]string, 0, len(rules.ExcludedExtensions)),
		DropboxMode:        strings.ToLower(strings.TrimSpace(rules.DropboxMode)),
		FilterMode:         strings.ToLower(strings.TrimSpace(rules.FilterMode)),
	}
	// Legacy profiles and extension writes retain their explicit filter choice.
	if normalized.FilterMode == "" {
		normalized.FilterMode = DropboxFilterOff
		if rules.Enabled {
			normalized.FilterMode = DropboxFilterCustom
		}
	}
	switch normalized.FilterMode {
	case DropboxFilterProject, DropboxFilterCustom:
		normalized.Enabled = true
	case DropboxFilterOff:
		normalized.Enabled = false
	default:
		return DownloadRules{}, &ValidationError{Message: "Dropbox filter mode must be project, off or custom"}
	}
	// Null means custom mode has never been initialized; an empty list is explicit.
	if rules.FilterMode != "" && rules.ExcludedExtensions == nil && normalized.FilterMode != DropboxFilterCustom {
		normalized.ExcludedExtensions = nil
	}
	if normalized.DropboxMode == "" {
		normalized.DropboxMode = DropboxModeDirect
	}
	if normalized.DropboxMode != DropboxModeDirect && normalized.DropboxMode != DropboxModeExpand {
		return DownloadRules{}, &ValidationError{Message: "Dropbox mode must be direct or expand"}
	}
	seen := make(map[string]struct{}, len(rules.ExcludedExtensions))
	for _, raw := range rules.ExcludedExtensions {
		value := strings.ToLower(strings.TrimSpace(raw))
		if !groupSuffixPattern.MatchString(value) {
			return DownloadRules{}, &ValidationError{Message: fmt.Sprintf("invalid excluded file extension %q", raw)}
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		normalized.ExcludedExtensions = append(normalized.ExcludedExtensions, value)
	}
	return normalized, nil
}

func (store *downloadRulesStore) snapshot() DownloadRules {
	store.mu.RLock()
	defer store.mu.RUnlock()
	return DownloadRules{
		Enabled:            store.rules.Enabled,
		ExcludedExtensions: slices.Clone(store.rules.ExcludedExtensions),
		DropboxMode:        store.rules.DropboxMode,
		FilterMode:         store.rules.FilterMode,
	}
}

func (store *downloadRulesStore) update(rules DownloadRules) (DownloadRules, error) {
	normalized, err := normalizeDownloadRules(rules)
	if err != nil {
		return DownloadRules{}, err
	}
	data, err := json.MarshalIndent(normalized, "", "  ")
	if err != nil {
		return DownloadRules{}, fmt.Errorf("encode download rules: %w", err)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := writeConfigFile(store.path, append(data, '\n')); err != nil {
		return DownloadRules{}, fmt.Errorf("persist download rules: %w", err)
	}
	store.rules = normalized
	return store.snapshotUnlocked(), nil
}

func (store *downloadRulesStore) updateRequest(request DownloadRulesUpdate) (DownloadRules, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	mode := store.rules.DropboxMode
	if request.DropboxMode != nil {
		mode = *request.DropboxMode
	}
	filterMode := ""
	if request.FilterMode != nil {
		filterMode = *request.FilterMode
		if strings.TrimSpace(filterMode) == "" {
			return DownloadRules{}, &ValidationError{Message: "Dropbox filter mode must be project, off or custom"}
		}
	}
	normalized, err := normalizeDownloadRules(DownloadRules{
		Enabled:            request.Enabled,
		ExcludedExtensions: request.ExcludedExtensions,
		DropboxMode:        mode,
		FilterMode:         filterMode,
	})
	if err != nil {
		return DownloadRules{}, err
	}
	data, err := json.MarshalIndent(normalized, "", "  ")
	if err != nil {
		return DownloadRules{}, fmt.Errorf("encode download rules: %w", err)
	}
	if err := writeConfigFile(store.path, append(data, '\n')); err != nil {
		return DownloadRules{}, fmt.Errorf("persist download rules: %w", err)
	}
	store.rules = normalized
	return store.snapshotUnlocked(), nil
}

func (store *downloadRulesStore) snapshotUnlocked() DownloadRules {
	return DownloadRules{
		Enabled:            store.rules.Enabled,
		ExcludedExtensions: slices.Clone(store.rules.ExcludedExtensions),
		DropboxMode:        store.rules.DropboxMode,
		FilterMode:         store.rules.FilterMode,
	}
}

// DownloadRules returns the current Dropbox mode and expansion filter defaults.
func (m *Manager) DownloadRules() DownloadRules {
	return m.downloadRules.snapshot()
}

// Resolve the project group for each expansion; never persist a stale copy.
func (m *Manager) dropboxFilterRules() DownloadRules {
	rules := m.DownloadRules()
	if rules.FilterMode == DropboxFilterProject {
		rules.ExcludedExtensions = []string{}
		for _, group := range m.FileGroups().Groups {
			if group.ID == "project" {
				rules.ExcludedExtensions = group.Extensions
				break
			}
		}
	}
	return rules
}

// SetDownloadRules persists the complete Dropbox mode and filter defaults.
func (m *Manager) SetDownloadRules(rules DownloadRules) (DownloadRules, error) {
	return m.downloadRules.update(rules)
}

// UpdateDownloadRules applies dashboard/API fields while allowing older
// filter-only clients to leave the independently configured Dropbox mode alone.
func (m *Manager) UpdateDownloadRules(update DownloadRulesUpdate) (DownloadRules, error) {
	return m.downloadRules.updateRequest(update)
}
