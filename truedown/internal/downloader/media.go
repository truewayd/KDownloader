package downloader

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// MediaOptions select native NEXT behavior. Manifests, segments, muxing and
// checkpoints belong exclusively to the engine, never to the manager.
type MediaOptions struct {
	Protocol   string `json:"protocol"`
	Format     string `json:"format,omitempty"`
	RecordTime int    `json:"recordTime,omitempty"`
}

type EngineCapabilities struct {
	Media bool `json:"media"`
	Probe bool `json:"probe"`
}

type engineCapabilitiesRPC interface{ capabilities() EngineCapabilities }
type nativeMediaRPC interface {
	retryMedia(string, map[string]any) error
	finishMedia(string) error
}

func (m *Manager) EngineCapabilities() EngineCapabilities {
	if !m.usesNext3() || m.engineExited.Load() {
		return EngineCapabilities{}
	}
	if rpc, ok := m.rpc.(engineCapabilitiesRPC); ok {
		return rpc.capabilities()
	}
	return EngineCapabilities{}
}

func (m *Manager) validateMediaOptions(opts *MediaOptions) error {
	if opts == nil {
		return nil
	}
	if opts.Protocol != "hls" && opts.Protocol != "dash" {
		return &ValidationError{Message: "media protocol must be hls or dash"}
	}
	if opts.Format != "" && opts.Format != "mp4" && opts.Format != "mkv" {
		return &ValidationError{Message: "media format must be mp4 or mkv"}
	}
	if opts.RecordTime < 0 || opts.RecordTime > 7*24*60*60 {
		return &ValidationError{Message: "media recordTime must be between 0 and 604800 seconds"}
	}
	return nil
}

func (m *Manager) requiresMediaEngine(task *Task) bool {
	return isMediaTask(task) && !m.engineExited.Load() && task.Status != StatusDone && task.Status != StatusError && !m.EngineCapabilities().Media
}

func isMediaTask(task *Task) bool { return task != nil && task.Opts.Media != nil }

func mediaEngineOptions(task *Task, options map[string]any) {
	media := task.Opts.Media
	delete(options, "out")
	delete(options, "check-integrity")
	options["media"] = media.Protocol
	options["media-format"] = firstNonEmptyString(media.Format, "mp4")
	options["media-record-time"] = strconv.Itoa(media.RecordTime)
	options["auto-file-renaming"] = "true"
	options["allow-overwrite"] = "false"
	// The original user hint is a title, not a guessed container filename.
	var name string
	var identity requestIdentity
	if json.Unmarshal([]byte(task.RequestJSON), &identity) == nil {
		name = identity.Name
	}
	if name != "" {
		options["filename-hint"] = name
		options["filename-hint-source"] = "title"
	}
}

type ariaMediaStatus struct {
	State             string `json:"state"`
	Protocol          string `json:"protocol"`
	Live              string `json:"live"`
	Duration          string `json:"duration"`
	CompletedDuration string `json:"completedDuration"`
	DownloadedLength  string `json:"downloadedLength"`
	Progress          string `json:"progress"`
	ErrorCode         string `json:"errorCode"`
}

// MediaProgress excludes manifest URLs, tracks and engine error text, which
// may contain browser credentials. Durations are milliseconds.
type MediaProgress struct {
	State             string  `json:"state"`
	Protocol          string  `json:"protocol"`
	Live              bool    `json:"live"`
	Duration          int64   `json:"duration"`
	CompletedDuration int64   `json:"completedDuration"`
	DownloadedLength  int64   `json:"downloadedLength"`
	Progress          float64 `json:"progress"`
	ErrorCode         string  `json:"errorCode,omitempty"`
}

func mediaProgress(state *ariaMediaStatus) *MediaProgress {
	if state == nil {
		return nil
	}
	positive := func(value string) int64 { n, _ := strconv.ParseInt(value, 10, 64); return max(0, n) }
	progress, _ := strconv.ParseFloat(state.Progress, 64)
	if math.IsNaN(progress) || math.IsInf(progress, 0) {
		progress = 0
	}
	return &MediaProgress{
		State: truncateText(state.State, 32), Protocol: truncateText(state.Protocol, 8), Live: state.Live == "true",
		Duration: positive(state.Duration), CompletedDuration: positive(state.CompletedDuration),
		DownloadedLength: positive(state.DownloadedLength), Progress: max(0, min(1, progress)),
		ErrorCode: mediaErrorCode(state.ErrorCode),
	}
}

func mediaErrorCode(code string) string {
	switch code {
	case "unsupported_source", "authentication_required", "protected_media", "unsupported_selection", "probe_failed":
		return code
	case "":
		return ""
	default:
		return "media_failed"
	}
}

func formatMediaProgress(media *MediaProgress) string {
	if media.Live {
		return fmt.Sprintf("%s · %ds recorded · %s", media.State, media.CompletedDuration/1000, formatBytes(media.DownloadedLength))
	}
	if media.Duration <= 0 {
		return media.State
	}
	return fmt.Sprintf("%.1f%% · %s · %s", 100*media.Progress, media.State, formatBytes(media.DownloadedLength))
}

// Native failed media keeps its GID and cache. Never retire its result before
// retryMedia, nor inspect or recreate the engine's media state directory.
func (m *Manager) keepRetryGID(task *Task) bool {
	return (isMediaTask(task) && task.Status == StatusError) || m.keepHTTPRetryGID(task)
}

func (m *Manager) FinishMediaTasks(ids []int64) TaskOperationResult {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	result := newOperationResult()
	rpc, supported := m.rpc.(nativeMediaRPC)
	for _, id := range uniqueTaskIDs(ids) {
		task, found := m.GetTask(id)
		if !found || !isMediaTask(task) || !supported || !m.EngineCapabilities().Media {
			result.fail(id, fmt.Errorf("task %d does not support native media finalization", id))
			continue
		}
		state, err := m.rpc.status(task.GID)
		if err == nil && task.Status == StatusPaused {
			// pause is asynchronous in NEXT. finishMedia only unpauses a task
			// that has actually reached Paused, so serialize this transition.
			deadline := time.Now().Add(3 * time.Second)
			for state.Status == "active" && time.Now().Before(deadline) && m.lifecycleCtx.Err() == nil {
				time.Sleep(25 * time.Millisecond)
				state, err = m.rpc.status(task.GID)
				if err != nil {
					break
				}
			}
			if err == nil && state.Status == "active" {
				err = fmt.Errorf("native pause is still pending")
			}
		}
		if err == nil && (state.Media == nil || state.Media.Live != "true" || (state.Status != "active" && state.Status != "paused" && state.Status != "waiting")) {
			err = fmt.Errorf("task %d is not a live recording", id)
		}
		if err == nil {
			err = rpc.finishMedia(task.GID)
		}
		if err != nil {
			result.fail(id, fmt.Errorf("could not finalize live recording %d", id))
			continue
		}
		if err := m.setTask(id, func(current *Task) {
			current.Status = StatusQueued
			current.Progress = "Waiting for aria2 to finalize recording"
		}); err != nil {
			result.fail(id, err)
			continue
		}
		// Polling observes finalizing/complete; accepting the request is not completion.
		result.Succeeded = append(result.Succeeded, id)
	}
	return result
}

func validateMediaExtraArgs(opts Aria2Opts) error {
	for _, raw := range opts.ExtraArgs {
		name, _, _ := strings.Cut(strings.TrimPrefix(strings.TrimSpace(raw), "--"), "=")
		name = strings.ToLower(name)
		if name == "media" || strings.HasPrefix(name, "media-") || name == "filename-hint" || name == "filename-hint-source" {
			return &ValidationError{Message: "use the media download controls instead of raw media options"}
		}
		if opts.Media != nil && name == "checksum" {
			return &ValidationError{Message: "source checksums cannot validate a remuxed media output"}
		}
	}
	return nil
}

func cloneMediaProgress(value *MediaProgress) *MediaProgress {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func sameMediaProgress(a, b *MediaProgress) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func (m *Manager) attachNativeMedia(task *Task, options map[string]any) (attached, deferred bool, err error) {
	state, err := m.rpc.status(task.GID)
	if isGIDNotFound(err) {
		return false, false, nil
	}
	if err != nil {
		return false, false, err
	}
	if state.Media == nil {
		return false, false, fmt.Errorf("native task is not media")
	}
	switch state.Status {
	case "error":
		if task.Status == StatusPaused {
			return false, true, nil
		}
		rpc, ok := m.rpc.(nativeMediaRPC)
		if !ok {
			return false, false, fmt.Errorf("native media retry is unavailable")
		}
		err = rpc.retryMedia(task.GID, options)
	case "active", "waiting", "paused":
		if task.Status == StatusPaused && state.Status != "paused" {
			err = m.rpc.pause(task.GID)
		}
		if task.Status == StatusQueued && state.Status == "paused" {
			err = m.rpc.unpause(task.GID)
		}
	case "complete":
		// Publication may have finished just before the manager stopped.
	default:
		return false, false, fmt.Errorf("native media task is unavailable")
	}
	return err == nil, false, err
}
