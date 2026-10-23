package downloader

import "fmt"

func removalGIDs(task *Task) []string {
	var gids []string
	for _, gid := range []string{task.GID, task.PreviousGID} {
		if gid != "" && (len(gids) == 0 || gids[0] != gid) {
			gids = append(gids, gid)
		}
	}
	return gids
}

// A failed retry can leave the previous writer alive even when its new GID
// does not exist. Stop every generation before touching bytes or its record.
func (m *Manager) stopRemovalWriters(task *Task, active bool) (string, bool, []string, error) {
	gids := removalGIDs(task)
	for _, gid := range gids {
		if m.artifacts != nil {
			if err := m.artifacts.retire(gid); err != nil {
				return "", false, nil, err
			}
		}
	}
	inspect := active || task.PreviousGID != ""
	if m.rpc == nil {
		if inspect {
			return "", false, nil, fmt.Errorf("aria2 is not running")
		}
		return "", false, gids, nil
	}
	if !inspect {
		return "", false, gids, nil
	}
	path, partial, preserve := "", false, false
	preserved := make(map[string]bool)
	for _, gid := range gids {
		state, err := m.rpc.status(gid)
		if isGIDNotFound(err) {
			// Missing state cannot distinguish unsubmitted from completed and
			// evicted. Keep bytes conservatively, including repeated cancellation.
			preserve = true
			continue
		}
		if err != nil {
			return "", false, nil, fmt.Errorf("inspect engine task %s: %w", gid, err)
		}
		original := state
		if state.Status == "active" || state.Status == "waiting" || state.Status == "paused" {
			if err := m.rpc.forceRemove(gid); err != nil {
				if isGIDNotFound(err) {
					preserve = true
					continue
				}
				return "", false, nil, fmt.Errorf("stop engine task %s: %w", gid, err)
			}
			state, err = waitForAriaStop(m.rpc, gid)
			if err != nil {
				return "", false, nil, err
			}
		}
		switch state.Status {
		case "missing":
			preserve = true
		case "complete", "error":
			preserve = true
			preserved[gid] = true
		case "removed":
			partial = true
			candidate := ""
			if len(state.Files) > 0 {
				candidate = state.Files[0].Path
			} else if len(original.Files) > 0 {
				candidate = original.Files[0].Path
			}
			if candidate != "" {
				if path != "" && !samePathName(path, candidate) {
					return "", false, nil, fmt.Errorf("download generations disagree on output path")
				}
				path = candidate
			}
		default:
			return "", false, nil, fmt.Errorf("unexpected aria2 status %q for %s", state.Status, gid)
		}
	}
	// Retain completed/error evidence until every non-preserving result is
	// retired. A failed removal or restart must not authorize later deletion.
	var retirement []string
	for _, gid := range gids {
		if !preserved[gid] {
			retirement = append(retirement, gid)
		}
	}
	for _, gid := range gids {
		if preserved[gid] {
			retirement = append(retirement, gid)
		}
	}
	return path, partial && !preserve, retirement, nil
}
