package downloader

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

var excludedExtensionPattern = regexp.MustCompile(`^\.[a-z0-9]{1,16}$`)

var defaultExcludedExtensions = []string{
	".psd", ".clip", ".sai", ".sai2", ".kra", ".xcf", ".procreate", ".afphoto", ".afdesign", ".blend",
}

// DownloadRules controls server-side filtering while a folder is expanded.
type DownloadRules struct {
	Enabled            bool     `json:"enabled"`
	ExcludedExtensions []string `json:"excludedExtensions"`
}

type downloadRulesStore struct {
	mu    sync.RWMutex
	path  string
	rules DownloadRules
}

func newDownloadRulesStore(databasePath string) (*downloadRulesStore, error) {
	store := &downloadRulesStore{
		path:  filepath.Join(filepath.Dir(databasePath), "truedown.download-rules.json"),
		rules: defaultDownloadRules(),
	}
	data, err := os.ReadFile(store.path)
	if os.IsNotExist(err) {
		return store, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read download rules: %w", err)
	}
	var rules DownloadRules
	if err := json.Unmarshal(data, &rules); err != nil {
		return nil, fmt.Errorf("decode download rules: %w", err)
	}
	normalized, err := normalizeDownloadRules(rules)
	if err != nil {
		return nil, fmt.Errorf("validate download rules: %w", err)
	}
	store.rules = normalized
	return store, nil
}

func defaultDownloadRules() DownloadRules {
	return DownloadRules{ExcludedExtensions: append([]string(nil), defaultExcludedExtensions...)}
}

func normalizeDownloadRules(rules DownloadRules) (DownloadRules, error) {
	if len(rules.ExcludedExtensions) > 64 {
		return DownloadRules{}, &ValidationError{Message: "too many excluded file extensions"}
	}
	normalized := DownloadRules{
		Enabled:            rules.Enabled,
		ExcludedExtensions: make([]string, 0, len(rules.ExcludedExtensions)),
	}
	seen := make(map[string]struct{}, len(rules.ExcludedExtensions))
	for _, raw := range rules.ExcludedExtensions {
		value := strings.ToLower(strings.TrimSpace(raw))
		if !excludedExtensionPattern.MatchString(value) {
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
		ExcludedExtensions: append([]string(nil), store.rules.ExcludedExtensions...),
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
	if err := os.MkdirAll(filepath.Dir(store.path), 0700); err != nil {
		return DownloadRules{}, fmt.Errorf("create download-rules directory: %w", err)
	}
	if err := os.WriteFile(store.path, append(data, '\n'), 0600); err != nil {
		return DownloadRules{}, fmt.Errorf("persist download rules: %w", err)
	}
	store.rules = normalized
	return store.snapshotUnlocked(), nil
}

func (store *downloadRulesStore) snapshotUnlocked() DownloadRules {
	return DownloadRules{
		Enabled:            store.rules.Enabled,
		ExcludedExtensions: append([]string(nil), store.rules.ExcludedExtensions...),
	}
}

// DownloadRules returns the current server-side folder filter.
func (m *Manager) DownloadRules() DownloadRules {
	return m.downloadRules.snapshot()
}

// SetDownloadRules persists the server-side folder filter.
func (m *Manager) SetDownloadRules(rules DownloadRules) (DownloadRules, error) {
	return m.downloadRules.update(rules)
}
