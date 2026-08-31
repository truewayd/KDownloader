package downloader

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

const (
	defaultConcurrentDownloads       = 3
	maxGlobalDownloadLimitBps  int64 = 1 << 50
	maxRuntimeSettingsBytes    int64 = 4096
)

// RuntimeSettings controls aria2-wide behavior shared by every task.
type RuntimeSettings struct {
	ConcurrentDownloads    int   `json:"concurrentDownloads"`
	GlobalDownloadLimitBps int64 `json:"globalDownloadLimitBps"`
}

// RuntimeSettingsUpdate keeps new fields optional for older dashboard clients.
type RuntimeSettingsUpdate struct {
	ConcurrentDownloads    int    `json:"concurrentDownloads"`
	GlobalDownloadLimitBps *int64 `json:"globalDownloadLimitBps"`
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
	var settings RuntimeSettings
	err := readStrictJSONFile(store.path, maxRuntimeSettingsBytes, &settings)
	if os.IsNotExist(err) {
		return store, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read runtime settings: %w", err)
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
	if settings.GlobalDownloadLimitBps < 0 || settings.GlobalDownloadLimitBps > maxGlobalDownloadLimitBps {
		return RuntimeSettings{}, &ValidationError{Message: "globalDownloadLimitBps must be between 0 and 1125899906842624"}
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
	if err := writeConfigFile(store.path, append(data, '\n')); err != nil {
		return RuntimeSettings{}, fmt.Errorf("persist runtime settings: %w", err)
	}
	store.settings = normalized
	return store.settings, nil
}

// RuntimeSettings returns the current aria2-wide settings.
func (m *Manager) RuntimeSettings() RuntimeSettings {
	return m.runtimeSettings.snapshot()
}

// UpdateRuntimeSettings preserves settings unknown to older dashboard clients.
func (m *Manager) UpdateRuntimeSettings(update RuntimeSettingsUpdate) (RuntimeSettings, error) {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	settings := m.RuntimeSettings()
	settings.ConcurrentDownloads = update.ConcurrentDownloads
	if update.GlobalDownloadLimitBps != nil {
		settings.GlobalDownloadLimitBps = *update.GlobalDownloadLimitBps
	}
	normalized, err := normalizeRuntimeSettings(settings)
	if err != nil {
		return RuntimeSettings{}, err
	}
	return m.setRuntimeSettingsLocked(normalized)
}

// SetRuntimeSettings applies aria2-wide settings immediately and persists them.
func (m *Manager) SetRuntimeSettings(settings RuntimeSettings) (RuntimeSettings, error) {
	normalized, err := normalizeRuntimeSettings(settings)
	if err != nil {
		return RuntimeSettings{}, err
	}
	m.opMu.Lock()
	defer m.opMu.Unlock()
	return m.setRuntimeSettingsLocked(normalized)
}

func (m *Manager) setRuntimeSettingsLocked(normalized RuntimeSettings) (RuntimeSettings, error) {
	previous := m.RuntimeSettings()
	if m.rpc != nil {
		if err := m.rpc.changeGlobalOptions(runtimeAriaOptions(normalized)); err != nil {
			return RuntimeSettings{}, fmt.Errorf("apply aria2 runtime settings: %w", err)
		}
	}
	saved, err := m.runtimeSettings.update(normalized)
	if err == nil {
		return saved, nil
	}
	if m.rpc != nil {
		_ = m.rpc.changeGlobalOptions(runtimeAriaOptions(previous))
	}
	return RuntimeSettings{}, err
}

func runtimeAriaOptions(settings RuntimeSettings) map[string]string {
	return map[string]string{
		"max-concurrent-downloads":   fmt.Sprintf("%d", settings.ConcurrentDownloads),
		"max-overall-download-limit": fmt.Sprintf("%d", settings.GlobalDownloadLimitBps),
	}
}
