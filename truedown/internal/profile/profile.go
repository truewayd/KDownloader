// Package profile is the single authority for persistent profile locations.
// The current file names stay compatible with existing installations. Callers
// must not introduce independent environment switches or duplicate preferences.
package profile

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// Durable files are grouped by ownership here, even while the on-disk legacy
// layout is retained. Secrets never belong in task snapshots or preferences exports.
const (
	Database        = "truedown.db"
	AuthSettings    = "truedown.auth.json"
	Token           = "truedown.token"
	RuntimeSettings = "truedown.settings.json"
	DownloadRules   = "truedown.download-rules.json"
	TaskDefaults    = "truedown.task-defaults.json"
	Modules         = "truedown.modules.json"
	TrackerState    = "truedown.tracker-research.json"
	UpdateState     = "truedown.updates.json"
)

type Location struct {
	DataDirectory string `json:"dataDirectory"`
	Source        string `json:"source"`
}

func File(root, name string) string { return filepath.Join(root, name) }

// Resolve does not create, copy or move files. Existing Windows profiles beside
// the launcher remain authoritative until explicitly moved while the core is off.
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
	return Location{DataDirectory: filepath.Clean(path), Source: source}, nil
}

func hasLegacyProfile(root string) (bool, error) {
	for _, name := range []string{Database, AuthSettings, Token, RuntimeSettings, DownloadRules, TaskDefaults, Modules, TrackerState, UpdateState} {
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
