package downloader

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

const defaultConcurrentDownloads = 3

// RuntimeSettings controls aria2-wide behavior shared by every task.
type RuntimeSettings struct {
	ConcurrentDownloads int `json:"concurrentDownloads"`
}

type runtimeSettingsStore struct {
	mu       sync.RWMutex
	path     string
	settings RuntimeSettings
}

func newRuntimeSettingsStore(databasePath string) (*runtimeSettingsStore, error) {
	store := &runtimeSettingsStore{
		path:     filepath.Join(filepath.Dir(databasePath), "truedown.settings.json"),
		settings: defaultRuntimeSettings(),
	}
	data, err := os.ReadFile(store.path)
	if os.IsNotExist(err) {
		return store, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read runtime settings: %w", err)
	}
	var settings RuntimeSettings
	if err := json.Unmarshal(data, &settings); err != nil {
		return nil, fmt.Errorf("decode runtime settings: %w", err)
	}
	normalized, err := normalizeRuntimeSettings(settings)
	if err != nil {
		return nil, fmt.Errorf("validate runtime settings: %w", err)
	}
	store.settings = normalized
	return store, nil
}

func defaultRuntimeSettings() RuntimeSettings {
	return RuntimeSettings{ConcurrentDownloads: defaultConcurrentDownloads}
}

func normalizeRuntimeSettings(settings RuntimeSettings) (RuntimeSettings, error) {
	if settings.ConcurrentDownloads < 1 || settings.ConcurrentDownloads > 64 {
		return RuntimeSettings{}, &ValidationError{Message: "concurrentDownloads must be between 1 and 64"}
	}
	return settings, nil
}

func (store *runtimeSettingsStore) snapshot() RuntimeSettings {
	store.mu.RLock()
	defer store.mu.RUnlock()
	return store.settings
}

func (store *runtimeSettingsStore) update(settings RuntimeSettings) (RuntimeSettings, error) {
	normalized, err := normalizeRuntimeSettings(settings)
	if err != nil {
		return RuntimeSettings{}, err
	}
	data, err := json.MarshalIndent(normalized, "", "  ")
	if err != nil {
		return RuntimeSettings{}, fmt.Errorf("encode runtime settings: %w", err)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(store.path), 0700); err != nil {
		return RuntimeSettings{}, fmt.Errorf("create runtime-settings directory: %w", err)
	}
	if err := os.WriteFile(store.path, append(data, '\n'), 0600); err != nil {
		return RuntimeSettings{}, fmt.Errorf("persist runtime settings: %w", err)
	}
	store.settings = normalized
	return store.settings, nil
}

// RuntimeSettings returns the current aria2-wide settings.
func (m *Manager) RuntimeSettings() RuntimeSettings {
	return m.runtimeSettings.snapshot()
}

// SetRuntimeSettings applies aria2-wide settings immediately and persists them.
func (m *Manager) SetRuntimeSettings(settings RuntimeSettings) (RuntimeSettings, error) {
	normalized, err := normalizeRuntimeSettings(settings)
	if err != nil {
		return RuntimeSettings{}, err
	}
	m.opMu.Lock()
	defer m.opMu.Unlock()
	previous := m.RuntimeSettings()
	if m.rpc != nil {
		if err := m.rpc.changeGlobalOptions(map[string]string{
			"max-concurrent-downloads": fmt.Sprintf("%d", normalized.ConcurrentDownloads),
		}); err != nil {
			return RuntimeSettings{}, fmt.Errorf("apply concurrent download limit: %w", err)
		}
	}
	saved, err := m.runtimeSettings.update(normalized)
	if err == nil {
		return saved, nil
	}
	if m.rpc != nil {
		_ = m.rpc.changeGlobalOptions(map[string]string{
			"max-concurrent-downloads": fmt.Sprintf("%d", previous.ConcurrentDownloads),
		})
	}
	return RuntimeSettings{}, err
}
