// Package profile is the single authority for persistent profile locations.
// Versioned layouts keep configuration, durable data, state, logs and caches
// together logically while respecting each platform's storage conventions.
package profile

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// Durable names are stable across layout migrations. Secrets never belong in
// task snapshots or preferences exports.
const (
	Database        = "truedown.db"
	AuthSettings    = "truedown.auth.json"
	Token           = "truedown.token"
	RuntimeSettings = "truedown.settings.json"
	DownloadRules   = "truedown.download-rules.json"
	TaskDefaults    = "truedown.task-defaults.json"
	FileGroups      = "truedown.file-groups.json"
	Modules         = "truedown.modules.json"
	TrackerState    = "truedown.tracker-research.json"
	UpdateState     = "truedown.updates.json"
)

type Location struct {
	DataDirectory string `json:"dataDirectory"`
	Source        string `json:"source"`
	LayoutVersion int    `json:"layoutVersion"`
	Paths         Paths  `json:"paths"`
}

func File(root, name string) string { return filepath.Join(root, name) }

// Resolve does not create, copy or move files. Existing Windows profiles beside
// the launcher remain authoritative until Initialize commits their new layout.
// An explicit path has precedence over the environment and platform defaults.
func Resolve(explicit, executableDir string) (Location, error) {
	if explicit != "" {
		return absolute(explicit, "explicit")
	}
	if value := os.Getenv("TRUEDOWN_DATA_DIR"); value != "" {
		return absolute(value, "environment")
	}
	if runtime.GOOS == "windows" {
		found, err := hasLegacyProfile(executableDir)
		if err != nil {
			return Location{}, err
		}
		if found {
			return absolute(executableDir, "legacy")
		}
	}
	dir, err := DefaultDirectory()
	if err != nil {
		return Location{}, err
	}
	return absolute(dir, "platform")
}

func absolute(path, source string) (Location, error) {
	path, err := filepath.Abs(path)
	if err != nil {
		return Location{}, err
	}
	path, err = canonical(path)
	if err != nil {
		return Location{}, err
	}
	location := Location{DataDirectory: path, Source: source}
	if state, err := readLayout(path); err == nil {
		location.Paths, location.LayoutVersion, location.Source = state.Paths, state.Version, state.Source
		return location, nil
	} else if !os.IsNotExist(err) {
		return Location{}, err
	}
	found, err := hasLegacyProfile(path)
	if err != nil {
		return Location{}, err
	}
	if found {
		location.Paths = FlatPaths(path)
		return location, nil
	}
	location.Paths, err = planPaths(path, source)
	location.LayoutVersion = 1
	return location, err
}

// Resolve existing ancestors too, so aliases of a not-yet-created profile have
// the same lock, desktop identity and login registration from the first launch.
func canonical(path string) (string, error) {
	resolved, err := filepath.EvalSymlinks(path)
	if err == nil {
		return filepath.Clean(resolved), nil
	}
	if !os.IsNotExist(err) {
		return "", err
	}
	parent := filepath.Dir(path)
	if parent == path {
		return filepath.Clean(path), nil
	}
	resolved, err = canonical(parent)
	if err != nil {
		return "", err
	}
	return filepath.Join(resolved, filepath.Base(path)), nil
}

func hasLegacyProfile(root string) (bool, error) {
	names := []string{LayoutFile, LayoutFile + ".bak", Database, Database + "-wal"}
	for _, name := range []string{AuthSettings, Token, RuntimeSettings, DownloadRules, TaskDefaults, FileGroups, Modules, TrackerState, UpdateState} {
		names = append(names, name, name+".bak")
	}
	for _, name := range names {
		info, err := os.Lstat(File(root, name))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return false, fmt.Errorf("inspect existing TrueDown profile: %w", err)
		}
		if !info.Mode().IsRegular() {
			return false, fmt.Errorf("existing TrueDown profile entry %s must be a regular file", name)
		}
		return true, nil
	}
	return false, nil
}
