package startup

import (
	"errors"
	"testing"
)

type memoryEntry struct {
	value  string
	fail   bool
	writes int
}

func (e *memoryEntry) Read() (string, error) { return e.value, nil }
func (e *memoryEntry) Write(value string) error {
	if e.fail {
		return errors.New("write denied")
	}
	e.value = value
	e.writes++
	return nil
}
func (e *memoryEntry) Remove() error { return e.Write("") }

func TestRegistrationRoundTripAndExternalChanges(t *testing.T) {
	entry := &memoryEntry{}
	manager := &Manager{entry: entry, command: "quoted executable and fixed arguments"}
	state, err := manager.Snapshot()
	if err != nil || !state.Supported || state.Enabled {
		t.Fatalf("initial state: %+v %v", state, err)
	}
	state, err = manager.SetEnabled(true)
	if err != nil || !state.Enabled {
		t.Fatalf("enabled state: %+v %v", state, err)
	}
	// The OS registration is the source of truth, including after process restart.
	reopened := &Manager{entry: entry, command: manager.command}
	state, err = reopened.Snapshot()
	if err != nil || !state.Enabled {
		t.Fatalf("reopened state: %+v %v", state, err)
	}
	entry.fail = true
	if _, err := manager.SetEnabled(false); err == nil {
		t.Fatal("reported success after a failed OS write")
	}
	state, _ = manager.Snapshot()
	if !state.Enabled {
		t.Fatal("failed disable changed the visible preference")
	}
	entry.fail = false
	state, err = manager.SetEnabled(false)
	if err != nil || state.Enabled || entry.value != "" {
		t.Fatalf("disabled state: %+v %v", state, err)
	}
	entry.value = "another executable"
	for _, enabled := range []bool{false, true} {
		if _, err := manager.SetEnabled(enabled); err == nil {
			t.Fatal("overwrote an unrelated startup command")
		}
		if entry.value != "another executable" {
			t.Fatal("removed an unrelated registration")
		}
	}
}

func TestUnsupportedStartupDoesNotClaimSuccess(t *testing.T) {
	manager := &Manager{reason: "unsupported platform"}
	state, err := manager.Snapshot()
	if err != nil || state.Supported || state.Enabled || state.Reason == "" {
		t.Fatalf("state: %+v %v", state, err)
	}
	if _, err := manager.SetEnabled(true); err == nil {
		t.Fatal("enabled unsupported startup")
	}
}
