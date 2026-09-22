package systemupdate

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"

	"truedown/internal/safefile"
)

// A separate journal keeps rollback binaries compatible with update settings.
// Entries authorize only verified assets in the profile's managed directories.
type updateDownload struct {
	Build  int64  `json:"build,omitempty"`
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

var nextDownloadName = regexp.MustCompile(`^aria2-next-[0-9]+\.[0-9]+\.[0-9]+-windows-(x86_64|arm64)\.exe$`)

func (entry updateDownload) valid() bool {
	if entry.Size <= 0 || entry.Size > maxReleaseArchiveBytes || normalizeSHA256(entry.SHA256) != entry.SHA256 || entry.SHA256 == "" {
		return false
	}
	if entry.Build > 0 {
		return entry.Name == fmt.Sprintf("TrueDown-build-%d.zip", entry.Build)
	}
	return entry.Build == 0 && entry.Size <= maxEngineBytes && nextDownloadName.MatchString(entry.Name)
}

func (m *Manager) readUpdateDownloads() ([]updateDownload, error) {
	data, err := safefile.ReadFile(m.cleanupPath, 64<<10)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var entries []updateDownload
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&entries); err != nil {
		return nil, err
	}
	if decoder.Decode(new(any)) != io.EOF || len(entries) > 128 {
		return nil, fmt.Errorf("invalid update download journal")
	}
	for _, entry := range entries {
		if !entry.valid() {
			return nil, fmt.Errorf("invalid update download receipt")
		}
	}
	return entries, nil
}

func (m *Manager) writeUpdateDownloads(entries []updateDownload) error {
	data, err := json.Marshal(entries)
	if err != nil {
		return err
	}
	return safefile.WriteFile(m.cleanupPath, data, 0600)
}

func (m *Manager) recordUpdateDownload(entry updateDownload) error {
	if m.downloadAsset == nil || m.cleanupAsset == nil {
		return nil
	}
	entry.SHA256 = normalizeSHA256(entry.SHA256)
	if !entry.valid() {
		return fmt.Errorf("invalid update download receipt")
	}
	m.cleanupMu.Lock()
	defer m.cleanupMu.Unlock()
	entries, err := m.readUpdateDownloads()
	if err != nil {
		return err
	}
	for _, previous := range entries {
		if previous == entry {
			return nil
		}
	}
	if len(entries) >= 128 {
		return fmt.Errorf("update download cleanup journal is full")
	}
	return m.writeUpdateDownloads(append(entries, entry))
}

func (m *Manager) cleanupUpdateDownloads() {
	if m.cleanupAsset == nil {
		return
	}
	m.cleanupMu.Lock()
	defer m.cleanupMu.Unlock()
	entries, err := m.readUpdateDownloads()
	if err != nil {
		log.Printf("read update download cleanup: %v", err)
		return
	}
	remaining := make([]updateDownload, 0, len(entries))
	for _, entry := range entries {
		directory := m.enginesDir
		m.mu.RLock()
		eligible := m.state.NextEngine != nil && m.state.NextEngine.File == entry.Name && m.state.NextEngine.SHA256 == entry.SHA256
		if entry.Build > 0 {
			directory = m.updatesDir
			eligible = !m.programUpdatesDisabled && m.nativeExecutable != "" && m.currentBuild >= entry.Build
		}
		m.mu.RUnlock()
		if entry.Build > 0 {
			// The helper removes this marker only after health succeeds or rollback
			// finishes. A new core starting alone is not proof of installation.
			if _, err := os.Lstat(filepath.Join(m.baseDir, nativeMarkerName)); !os.IsNotExist(err) {
				eligible = false
			}
		} else if eligible {
			digest, size, err := nativeHash(filepath.Join(directory, entry.Name), maxEngineBytes)
			eligible = err == nil && digest == entry.SHA256 && size == entry.Size
		}
		if !eligible {
			remaining = append(remaining, entry)
			continue
		}
		if err := m.cleanupAsset(directory, entry.Name, entry.SHA256, entry.Size); err != nil {
			log.Printf("clean installed update download %s: %v", entry.Name, err)
			remaining = append(remaining, entry)
		}
	}
	if len(remaining) != len(entries) {
		if err := m.writeUpdateDownloads(remaining); err != nil {
			log.Printf("persist update download cleanup: %v", err)
		}
	}
}
