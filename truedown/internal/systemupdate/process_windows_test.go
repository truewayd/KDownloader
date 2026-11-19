//go:build windows

package systemupdate

import (
	"os"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestNativeHandoffWaitsForMatchingProcess(t *testing.T) {
	created, err := processCreationTime(windows.CurrentProcess())
	if err != nil {
		t.Fatal(err)
	}
	current := nativeExitProcess{PID: uint32(os.Getpid()), Created: created}
	if err := waitForNativeProcess(current, time.Now().Add(20*time.Millisecond)); err == nil ||
		!strings.Contains(err.Error(), "did not exit") {
		t.Fatalf("expected the live process to time out, got %v", err)
	}
	current.Created--
	if err := waitForNativeProcess(current, time.Now()); err != nil {
		t.Fatalf("a reused PID must not block the update: %v", err)
	}
}
