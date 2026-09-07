package systemupdate

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestLegacySingleExecutableStageIsRetiredWithoutResettingPreferences(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "truedown.updates.json")
	state := persistedState{SchemaVersion: 1, EnginePreference: EngineStable, AutoUpdateTrueDown: false,
		PendingUpdate: &pendingAppUpdate{Build: 2, Version: "truedown-build-2", File: "TrueDown-build-2.exe", SHA256: strings.Repeat("a", 64)}}
	if err := writeNativeJSON(statePath, state); err != nil {
		t.Fatal(err)
	}
	manager := &Manager{statePath: statePath, currentBuild: 1}
	if err := manager.loadState(); err != nil {
		t.Fatal(err)
	}
	if manager.state.PendingUpdate != nil || manager.state.AutoUpdateTrueDown || !manager.prunedNativeState {
		t.Fatal("legacy stage was retained or user preferences were reset")
	}
	if err := manager.persistLocked(); err != nil {
		t.Fatal(err)
	}
	var saved persistedState
	if err := readNativeJSON(statePath, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.PendingUpdate != nil || saved.AutoUpdateTrueDown {
		t.Fatal("retirement was not persisted")
	}
}
