package systemupdate

import (
	"context"
	"fmt"
	"runtime"
	"strconv"
	"strings"
)

// ConfigureAutomaticNext is called before RunAutomatic starts its worker.
func (m *Manager) ConfigureAutomaticNext(check func(context.Context), apply func()) {
	m.checkNextAutomatically, m.applyNextAutomatically = check, apply
}

// Serialize the final automatic switch with preference saves and program apply.
// Once disabling updates is acknowledged, an earlier candidate cannot start.
func (m *Manager) BeginAutomaticNextApply() (func(), bool) {
	m.applyMu.Lock()
	m.mu.RLock()
	enabled := m.state.AutoUpdateNext && !m.applyLaunched
	m.mu.RUnlock()
	if !enabled {
		m.applyMu.Unlock()
		return nil, false
	}
	return m.applyMu.Unlock, true
}

func (m *Manager) UpdateNextAutomatically(ctx context.Context) error {
	m.mu.RLock()
	enabled := m.state.AutoUpdateNext && m.state.NextEngine != nil
	m.mu.RUnlock()
	if runtime.GOOS != "windows" || !enabled {
		return nil
	}
	if err := m.begin("next-engine"); err != nil {
		return err
	}
	err := m.installNext(ctx, true)
	m.finish(err)
	return err
}

// RestorePreviousNext retains the last working version after a failed upgrade.
func (m *Manager) RestorePreviousNext(active EngineSpec) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	previous := m.state.PreviousNextEngine
	if previous == nil || active.Kind != EngineNext || active.File != previous.File || active.Version != previous.Version {
		return fmt.Errorf("previous NEXT metadata does not match the restored engine")
	}
	next := m.state
	if next.NextEngine != nil {
		next.NextFailedVersion = next.NextEngine.Version
	}
	next.NextEngine, next.PreviousNextEngine = previous, nil
	return m.persistStateLocked(next)
}

func compareEngineVersions(left, right string) int {
	a, b := strings.Split(left, "."), strings.Split(right, ".")
	for i := 0; i < len(a) || i < len(b); i++ {
		var x, y uint64
		if i < len(a) {
			x, _ = strconv.ParseUint(a[i], 10, 64)
		}
		if i < len(b) {
			y, _ = strconv.ParseUint(b[i], 10, 64)
		}
		if x < y {
			return -1
		}
		if x > y {
			return 1
		}
	}
	return 0
}
