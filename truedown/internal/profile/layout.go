package profile

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"

	"truedown/internal/safefile"
)

const (
	LayoutFile     = "truedown.profile.json"
	ApplicationLog = "truedown.log"
	AriaLog        = "aria2.log"
	AriaConsoleLog = "aria2-console.log"
	ModulePackages = "modules"
	Engines        = "engines"
	ResumeState    = "aria2-next-state"
	StagedUpdates  = "updates"
	WindowState    = "truedown.windows.json"
	WebViewCache   = "webview"
)

// Paths separates ownership and retention rules. Callers receive it at service
// composition; no manager or client may derive config paths from a database name.
type Paths struct {
	Config    string `json:"config"`
	Data      string `json:"data"`
	State     string `json:"state"`
	Logs      string `json:"logs"`
	Cache     string `json:"cache"`
	Downloads string `json:"downloads"`
}

func FlatPaths(root string) Paths {
	return Paths{Config: root, Data: root, State: root, Logs: root, Cache: filepath.Join(root, "cache"), Downloads: filepath.Join(root, "downloads")}
}

func (p Paths) File(name string) string {
	var directory string
	switch name {
	case AuthSettings, Token, RuntimeSettings, DownloadRules, TaskDefaults, Modules:
		directory = p.Config
	case Database, ModulePackages, Engines:
		directory = p.Data
	case TrackerState, UpdateState, ResumeState, StagedUpdates, WindowState:
		directory = p.State
	case ApplicationLog, AriaLog, AriaConsoleLog:
		directory = p.Logs
	case WebViewCache:
		directory = p.Cache
	default:
		panic("unknown profile file: " + name)
	}
	return filepath.Join(directory, name)
}

type layoutState struct {
	Version int      `json:"schemaVersion"`
	Source  string   `json:"source"`
	Paths   Paths    `json:"paths"`
	Backup  string   `json:"legacyBackup,omitempty"`
	Pending []string `json:"pendingArchive,omitempty"`
}

func readLayout(root string) (layoutState, error) {
	data, err := safefile.InspectFile(filepath.Join(root, LayoutFile), 64<<10)
	if err != nil {
		return layoutState{}, err
	}
	return decodeLayout(root, data)
}

func decodeLayout(root string, data []byte) (layoutState, error) {
	var state layoutState
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&state); err != nil {
		return state, fmt.Errorf("read profile layout: %w", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return state, fmt.Errorf("profile layout must contain one object")
	}
	if state.Version != 1 {
		return state, fmt.Errorf("unsupported profile layout version %d", state.Version)
	}
	if state.Source != "platform" && state.Source != "explicit" && state.Source != "environment" && state.Source != "legacy" {
		return state, fmt.Errorf("invalid profile layout source")
	}
	for _, directory := range []string{state.Paths.Config, state.Paths.Data, state.Paths.State, state.Paths.Logs, state.Paths.Cache, state.Paths.Downloads} {
		if !filepath.IsAbs(directory) || filepath.Clean(directory) != directory {
			return state, fmt.Errorf("profile layout contains a noncanonical directory")
		}
	}
	if state.Paths.Data != filepath.Join(root, "data") || state.Paths.Downloads != filepath.Join(root, "downloads") {
		return state, fmt.Errorf("profile data paths do not match their root")
	}
	if state.Source != "platform" {
		expected, _ := planPaths(root, state.Source)
		if state.Paths != expected {
			return state, fmt.Errorf("portable profile paths escaped their root")
		}
	}
	if state.Backup != "" && state.Backup != filepath.Join(root, "profile-backup-v0") {
		return state, fmt.Errorf("invalid profile backup directory")
	}
	if len(state.Pending) > 64 {
		return state, fmt.Errorf("invalid profile archive count")
	}
	for _, name := range state.Pending {
		if !legacyName(name) {
			return state, fmt.Errorf("invalid profile archive entry")
		}
	}
	return state, nil
}

func writeLayout(root string, state layoutState) error {
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	return safefile.WriteFile(filepath.Join(root, LayoutFile), append(data, '\n'), 0600)
}

func planPaths(root, source string) (Paths, error) {
	paths := Paths{Config: filepath.Join(root, "config"), Data: filepath.Join(root, "data"), State: filepath.Join(root, "state"), Logs: filepath.Join(root, "logs"), Cache: filepath.Join(root, "cache"), Downloads: filepath.Join(root, "downloads")}
	if source != "platform" {
		return paths, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return Paths{}, err
	}
	switch runtime.GOOS {
	case "linux":
		paths.Config = xdg("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
		paths.State = xdg("XDG_STATE_HOME", filepath.Join(home, ".local", "state"))
		paths.Logs = filepath.Join(paths.State, "logs")
		paths.Cache = xdg("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
		// XDG roots may intentionally coincide. Keep role directories distinct
		// even then, and keep the lock/layout anchor outside the config store.
		bases := []string{paths.Config, paths.State, paths.Cache}
		roles := []*string{&paths.Config, &paths.State, &paths.Cache}
		for index, base := range bases {
			conflict := base == root
			for other, candidate := range bases {
				if other != index && candidate == base {
					conflict = true
				}
			}
			if conflict {
				*roles[index] = filepath.Join(base, []string{"config", "state", "cache"}[index])
			}
		}
		paths.Logs = filepath.Join(paths.State, "logs")
	case "darwin":
		paths.Logs = filepath.Join(home, "Library", "Logs", "TrueDown")
		paths.Cache = filepath.Join(home, "Library", "Caches", "TrueDown")
	}
	return paths, nil
}

func xdg(key, fallback string) string {
	root := os.Getenv(key)
	if root == "" || !filepath.IsAbs(root) {
		root = fallback
	}
	return filepath.Join(root, "truedown")
}
