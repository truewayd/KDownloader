package downloader

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"truedown/internal/profile"
)

const maxTaskDefaultsBytes = 64 * 1024

var ErrDefaultsConflict = errors.New("task defaults changed; reload before saving")

// TaskDefaults stores user preferences shared by UI and CLI. Headers, proxy and
// extra options are private configuration and never belong in task snapshots.
type TaskDefaults struct {
	Folder         string  `json:"folder"`
	Connections    int     `json:"connections"`
	Speed          float64 `json:"speed"`
	SpeedUnit      int     `json:"speedUnit"`
	MaxTries       int     `json:"maxTries"`
	RetryWait      int     `json:"retryWait"`
	Proxy          string  `json:"proxy"`
	UserAgent      string  `json:"userAgent"`
	Referer        string  `json:"referer"`
	Headers        string  `json:"headers"`
	Allocation     string  `json:"allocation"`
	CheckIntegrity bool    `json:"checkIntegrity"`
	RemoteTime     bool    `json:"remoteTime"`
	Extra          string  `json:"extra"`
}

type TaskDefaultsSnapshot struct {
	Revision uint64       `json:"revision"`
	Values   TaskDefaults `json:"values"`
}

type taskDefaultsStore struct {
	mu    sync.Mutex
	path  string
	state TaskDefaultsSnapshot
}

func defaultTaskDefaults() TaskDefaults {
	return TaskDefaults{Connections: 16, SpeedUnit: 1048576, MaxTries: 5, RetryWait: 3, Allocation: "none", RemoteTime: true}
}

func newTaskDefaultsStore(databasePath string) (*taskDefaultsStore, error) {
	store := &taskDefaultsStore{path: profile.File(filepath.Dir(databasePath), profile.TaskDefaults), state: TaskDefaultsSnapshot{Values: defaultTaskDefaults()}}
	var state TaskDefaultsSnapshot
	err := readStrictJSONFile(store.path, maxTaskDefaultsBytes, &state)
	if os.IsNotExist(err) {
		return store, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read task defaults: %w", err)
	}
	if state.Revision == 0 {
		return nil, fmt.Errorf("invalid task defaults revision")
	}
	if err := validateTaskDefaults(state.Values); err != nil {
		return nil, err
	}
	store.state = state
	return store, nil
}

func validateTaskDefaults(v TaskDefaults) error {
	invalid := func() error { return &ValidationError{Message: "invalid task defaults"} }
	if v.Connections < 1 || v.MaxTries < 1 || v.RetryWait < 1 {
		return invalid()
	}
	if v.SpeedUnit != 1024 && v.SpeedUnit != 1048576 && v.SpeedUnit != 1073741824 {
		return invalid()
	}
	speed := v.Speed * float64(v.SpeedUnit)
	if math.IsNaN(speed) || math.IsInf(speed, 0) || speed < 0 || speed > 1<<50 {
		return invalid()
	}
	if v.Allocation != "none" && v.Allocation != "prealloc" && v.Allocation != "trunc" && v.Allocation != "falloc" {
		return invalid()
	}
	headers, err := v.requestHeaders()
	if err != nil {
		return invalid()
	}
	for _, raw := range v.options().ExtraArgs {
		name := strings.ToLower(strings.SplitN(strings.TrimPrefix(strings.TrimSpace(raw), "--"), "=", 2)[0])
		if isProtectedAriaOption(name) {
			return &ValidationError{Message: "protected aria2 options cannot be stored as defaults"}
		}
	}
	if err := validateRequest(normalizeRequest("https://example.com/file", "", v.Folder, ".", headers, v.Referer, 0, v.options())); err != nil {
		return err
	}
	data, err := json.Marshal(TaskDefaultsSnapshot{Revision: math.MaxUint64, Values: v})
	if err != nil || len(data)+1 > maxTaskDefaultsBytes {
		return invalid()
	}
	return nil
}

func (v TaskDefaults) requestHeaders() (map[string]string, error) {
	headers := make(map[string]string)
	if strings.TrimSpace(v.Headers) != "" {
		var values map[string]json.RawMessage
		if json.Unmarshal([]byte(v.Headers), &values) != nil || values == nil {
			return nil, fmt.Errorf("invalid default headers")
		}
		for _, value := range values {
			if len(value) == 0 || value[0] != '"' {
				return nil, fmt.Errorf("default header values must be strings")
			}
		}
		if err := json.Unmarshal([]byte(v.Headers), &headers); err != nil || headers == nil {
			return nil, fmt.Errorf("invalid default headers")
		}
	}
	if v.UserAgent != "" {
		found := false
		for k := range headers {
			if strings.EqualFold(k, "User-Agent") {
				found = true
			}
		}
		if !found {
			headers["User-Agent"] = v.UserAgent
		}
	}
	return headers, nil
}

func (v TaskDefaults) options() Aria2Opts {
	extra := []string{}
	if v.Proxy != "" {
		extra = append(extra, "--all-proxy="+v.Proxy)
	}
	extra = append(extra, "--file-allocation="+v.Allocation, fmt.Sprintf("--check-integrity=%t", v.CheckIntegrity), fmt.Sprintf("--remote-time=%t", v.RemoteTime))
	for _, line := range strings.Split(v.Extra, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			extra = append(extra, line)
		}
	}
	return Aria2Opts{Connections: v.Connections, MaxSpeedBps: int(math.Round(v.Speed * float64(v.SpeedUnit))), MaxTries: v.MaxTries, RetryWait: v.RetryWait, ExtraArgs: extra}
}

func (m *Manager) TaskDefaults() TaskDefaultsSnapshot {
	s := m.taskDefaults
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state
}

func (m *Manager) SetTaskDefaults(revision uint64, values TaskDefaults) (TaskDefaultsSnapshot, error) {
	if err := validateTaskDefaults(values); err != nil {
		return TaskDefaultsSnapshot{}, err
	}
	s := m.taskDefaults
	s.mu.Lock()
	defer s.mu.Unlock()
	if revision != s.state.Revision || revision == math.MaxUint64 {
		return s.state, ErrDefaultsConflict
	}
	next := TaskDefaultsSnapshot{Revision: revision + 1, Values: values}
	data, err := json.Marshal(next)
	if err != nil {
		return s.state, err
	}
	if err := writeConfigFile(s.path, append(data, '\n')); err != nil {
		return s.state, err
	}
	s.state = next
	return next, nil
}

// ApplyTaskDefaults is opt-in: older browser integrations preserve their own
// task parameters and credentials. Explicit options replace the default set;
// explicit headers override defaults case-insensitively.
func (m *Manager) ApplyTaskDefaults(folder, page string, headers map[string]string, opts *Aria2Opts) (string, string, map[string]string, Aria2Opts) {
	defaults := m.TaskDefaults().Values
	if folder == "" {
		folder = defaults.Folder
	}
	if page == "" {
		page = defaults.Referer
	}
	merged, _ := defaults.requestHeaders()
	for key, value := range headers {
		for existing := range merged {
			if strings.EqualFold(existing, key) {
				delete(merged, existing)
			}
		}
		merged[key] = value
	}
	options := defaults.options()
	if opts != nil {
		options = *opts
	}
	return folder, page, merged, options
}
