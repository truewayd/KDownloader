package downloader

import (
	"encoding/json"
	"fmt"
	"os"
)

const (
	CollectionLayoutModule   = "module"
	CollectionLayoutCategory = "category"
)

// Keep this preference separate from download rules so older cores can still
// read their strict configuration after an application rollback.
type CollectionLayoutSettings struct {
	Layout string `json:"layout"`
}

func (settings CollectionLayoutSettings) validate() error {
	switch settings.Layout {
	case CollectionLayoutModule, CollectionLayoutCategory:
		return nil
	default:
		return &ValidationError{Message: "collection layout must be module or category"}
	}
}

func loadCollectionLayout(path string) (string, error) {
	var settings CollectionLayoutSettings
	err := readStrictJSONFile(path, 1024, &settings)
	if os.IsNotExist(err) {
		return CollectionLayoutModule, nil
	}
	if err == nil {
		err = settings.validate()
	}
	if err != nil {
		return "", fmt.Errorf("read collection layout: %w", err)
	}
	return settings.Layout, nil
}

func (m *Manager) CollectionLayout() CollectionLayoutSettings {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return CollectionLayoutSettings{Layout: m.collectionLayout}
}

func (m *Manager) SetCollectionLayout(settings CollectionLayoutSettings) error {
	if err := settings.validate(); err != nil {
		return err
	}
	data, err := json.Marshal(settings)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if settings.Layout == m.collectionLayout {
		return nil
	}
	if err := writeConfigFile(m.collectionLayoutPath, append(data, '\n')); err != nil {
		return err
	}
	m.collectionLayout = settings.Layout
	return nil
}
