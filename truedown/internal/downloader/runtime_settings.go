package downloader

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
)

const (
	defaultConcurrentDownloads       = 3
	maxGlobalDownloadLimitBps  int64 = 1 << 50
	maxRuntimeSettingsBytes    int64 = 4096
	defaultBTUserAgent               = "qBittorrent/5.2.3"
	defaultBTPeerIDPrefix            = "-qB5230-"
)

// RuntimeSettings controls aria2-wide behavior shared by every task.
type RuntimeSettings struct {
	ConcurrentDownloads    int    `json:"concurrentDownloads"`
	GlobalDownloadLimitBps int64  `json:"globalDownloadLimitBps"`
	BTUserAgent            string `json:"btUserAgent"`
	BTPeerIDPrefix         string `json:"btPeerIdPrefix"`
}

// RuntimeSettingsUpdate keeps new fields optional for older dashboard clients.
type RuntimeSettingsUpdate struct {
	ConcurrentDownloads    *int    `json:"concurrentDownloads"`
	GlobalDownloadLimitBps *int64  `json:"globalDownloadLimitBps"`
	BTUserAgent            *string `json:"btUserAgent"`
	BTPeerIDPrefix         *string `json:"btPeerIdPrefix"`
}

type runtimeSettingsStore struct {
	mu       sync.RWMutex
	path     string
	settings RuntimeSettings
}

func newRuntimeSettingsStoreAt(path string) (*runtimeSettingsStore, error) {
	store := &runtimeSettingsStore{
		path:     path,
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
	return RuntimeSettings{ConcurrentDownloads: defaultConcurrentDownloads, BTUserAgent: defaultBTUserAgent, BTPeerIDPrefix: defaultBTPeerIDPrefix}
}

func normalizeRuntimeSettings(settings RuntimeSettings) (RuntimeSettings, error) {
	if settings.ConcurrentDownloads < 1 || settings.ConcurrentDownloads > 64 {
		return RuntimeSettings{}, &ValidationError{Message: "concurrentDownloads must be between 1 and 64"}
	}
	if settings.GlobalDownloadLimitBps < 0 || settings.GlobalDownloadLimitBps > maxGlobalDownloadLimitBps {
		return RuntimeSettings{}, &ValidationError{Message: "globalDownloadLimitBps must be between 0 and 1125899906842624"}
	}
	for _, field := range []struct {
		name, value string
		limit       int
	}{
		{"btUserAgent", settings.BTUserAgent, 512},
		{"btPeerIdPrefix", settings.BTPeerIDPrefix, 20},
	} {
		if len(field.value) > field.limit || strings.IndexFunc(field.value, func(r rune) bool { return r < 32 || r > 126 }) >= 0 {
			return RuntimeSettings{}, &ValidationError{Message: fmt.Sprintf("%s must contain at most %d printable ASCII bytes", field.name, field.limit)}
		}
	}
	settings.BTUserAgent = strings.TrimSpace(settings.BTUserAgent)
	settings.BTPeerIDPrefix = strings.TrimSpace(settings.BTPeerIDPrefix)
	if settings.BTUserAgent == "" {
		settings.BTUserAgent = defaultBTUserAgent
	}
	if settings.BTPeerIDPrefix == "" {
		settings.BTPeerIDPrefix = defaultBTPeerIDPrefix
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
	if update.ConcurrentDownloads != nil {
		settings.ConcurrentDownloads = *update.ConcurrentDownloads
	}
	if update.GlobalDownloadLimitBps != nil {
		settings.GlobalDownloadLimitBps = *update.GlobalDownloadLimitBps
	}
	if update.BTUserAgent != nil {
		settings.BTUserAgent = *update.BTUserAgent
	}
	if update.BTPeerIDPrefix != nil {
		settings.BTPeerIDPrefix = *update.BTPeerIDPrefix
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
		if err := m.rpc.changeGlobalOptions(m.runtimeAriaOptions(normalized)); err != nil {
			return RuntimeSettings{}, fmt.Errorf("apply aria2 runtime settings: %w", err)
		}
	}
	saved, err := m.runtimeSettings.update(normalized)
	if err == nil {
		return saved, nil
	}
	if m.rpc != nil {
		_ = m.rpc.changeGlobalOptions(m.runtimeAriaOptions(previous))
	}
	return RuntimeSettings{}, err
}

func (m *Manager) runtimeAriaOptions(settings RuntimeSettings) map[string]string {
	options := map[string]string{
		"max-concurrent-downloads":   fmt.Sprintf("%d", settings.ConcurrentDownloads),
		"max-overall-download-limit": fmt.Sprintf("%d", settings.GlobalDownloadLimitBps),
	}
	if m.supportsBTIdentity() {
		options["bt-user-agent"] = settings.BTUserAgent
		options["bt-peer-id-prefix"] = settings.BTPeerIDPrefix
	}
	return options
}

func (m *Manager) supportsBTIdentity() bool {
	return m.aria2Next && aria2NextVersionAtLeast(m.aria2NextVersion, 2, 6, 7)
}
