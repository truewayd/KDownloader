package systemupdate

import (
	"context"
	"testing"
)

func TestExternalLifecycleNeverAppliesLegacyStagedUpdate(t *testing.T) {
	m := &Manager{programUpdatesDisabled: true, currentBuild: 10}
	if _, err := m.UpdateTrueDown(context.Background()); err == nil {
		t.Fatal("external update check allowed")
	}
	if err := m.RequestRestart(); err == nil {
		t.Fatal("external restart allowed")
	}
	if err := m.LaunchPendingApply(nil); err == nil {
		t.Fatal("external helper allowed")
	}
	if m.Snapshot().TrueDown.Supported || m.HasPendingUpdate() {
		t.Fatal("legacy lifecycle advertised")
	}
	<-m.RunAutomatic(context.Background(), func() bool { t.Fatal("automatic apply invoked"); return true })
}
