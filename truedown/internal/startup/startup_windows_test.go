//go:build windows

package startup

import (
	"golang.org/x/sys/windows"
	"strings"
	"testing"
)

func TestStartupCommandPreservesDataDirectory(t *testing.T) {
	for _, key := range []string{"TRUEDOWN_ADDR", "TRUEDOWN_TLS_CERT", "TRUEDOWN_TLS_KEY", "TRUEDOWN_REQUIRE_TOKEN", "TRUEDOWN_API_TOKEN", "TRUEDOWN_ARIA2_PATH"} {
		t.Setenv(key, "")
	}
	manager := New(`C:\Download Data\profile`)
	if manager.entry == nil {
		t.Fatal(manager.reason)
	}
	args, err := windows.DecomposeCommandLine(manager.command)
	if err != nil || len(args) != 4 || args[1] != "background" || args[2] != "--data-dir" || args[3] != `C:\Download Data\profile` {
		t.Fatalf("command round trip = %q, %v", args, err)
	}
	other := New(`C:\Download Data\other`)
	if manager.entry == other.entry {
		t.Fatal("different profiles share a startup entry")
	}
	if New(`C:\`+strings.Repeat("x", 270)).entry != nil {
		t.Fatal("accepted an overlong login command")
	}
	t.Setenv("TRUEDOWN_API_TOKEN", "process-scoped-secret")
	if New(`C:\data`).entry != nil {
		t.Fatal("registered startup without reproducing externally managed auth")
	}
}
