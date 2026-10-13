package downloader

import "strings"

func (m *Manager) usesNext3() bool {
	return m.aria2Next && aria2NextVersionAtLeast(m.aria2NextVersion, 3, 0, 0)
}

func (m *Manager) engineTaskOptions(task *Task, recheck, restart, torrent bool) map[string]any {
	options := ariaOptions(task, recheck)
	if m.usesNativeHTTPState() {
		delete(options, "always-resume")
	}
	if m.usesNext3() && !torrent {
		// Ordinary HTTP tasks keep file semantics until explicit media admission.
		options["media"] = "file"
		// The engine still loads its native checkpoint with continue=false.
		// This only forbids treating an unverified file as a contiguous prefix.
		options["continue"] = "false"
		if restart {
			// This explicit retry has a fresh GID and the old result is retired.
			// Let the engine truncate the owned output; subsequent pauses can
			// still resume the new GID's checkpoint without a sticky reset flag.
			options["allow-overwrite"] = "true"
		}
	}
	return options
}

func (m *Manager) validateEngineOptions(opts Aria2Opts) error {
	if !m.aria2Next || !aria2NextVersionAtLeast(m.aria2NextVersion, 3, 0, 0) {
		return nil
	}
	for _, raw := range opts.ExtraArgs {
		name, _, _ := strings.Cut(strings.TrimPrefix(strings.TrimSpace(raw), "--"), "=")
		switch strings.ToLower(name) {
		case "stream-max-range-size":
			return &ValidationError{Message: "NEXT 3 removed stream-max-range-size; remove this option before retrying"}
		case "bt-resume-save-interval", "auto-save-interval", "state-save-interval":
			return &ValidationError{Message: "checkpoint timing is managed globally; remove task-level checkpoint options"}
		}
	}
	return nil
}
