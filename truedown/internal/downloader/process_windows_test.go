//go:build windows

package downloader

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestManagedProcessDoesNotCreateAConsoleWindow(t *testing.T) {
	command := exec.Command("aria2c.exe", "--version")
	configureManagedProcess(command)
	if command.SysProcAttr == nil || !command.SysProcAttr.HideWindow || command.SysProcAttr.CreationFlags&0x08000000 == 0 {
		t.Fatal("managed aria2 process is not configured for hidden execution")
	}
}

func TestEngineInterruptWithInheritedCtrlCIgnore(t *testing.T) {
	if os.Getenv("TRUEDOWN_INTEGRATION") == "" {
		t.Skip("set TRUEDOWN_INTEGRATION=1")
	}
	if os.Getenv("TRUEDOWN_IGNORE_CTRL_C_CHILD") != "1" {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestEngineInterruptWithInheritedCtrlCIgnore$", "-test.v")
		cmd.Env = append(os.Environ(), "TRUEDOWN_IGNORE_CTRL_C_CHILD=1")
		configureManagedProcess(cmd)
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("inherited ignore fixture: %v\n%s", err, output)
		}
		t.Logf("%s", output)
		return
	}
	// Isolate this process-wide flag from the test driver's signal handlers.
	setHandler := windows.NewLazySystemDLL("kernel32.dll").NewProc("SetConsoleCtrlHandler")
	if ok, _, err := setHandler.Call(0, 1); ok == 0 {
		t.Fatal(err)
	}
	path, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	m, err := NewManager(path, filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	m.Stop()
	t.Logf("ignored CTRL+C safe exit: %s, %v", time.Since(started), m.cmd.ProcessState)
	if !m.cmd.ProcessState.Success() || time.Since(started) > 2500*time.Millisecond {
		t.Fatal("engine ignored graceful interrupt and reached kill timeout")
	}
}

func TestStopFallsBackToRPCWhenInterruptUnavailable(t *testing.T) {
	root := t.TempDir()
	manager, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	rpc := &fakeAriaRPC{}
	manager.rpc = rpc
	manager.cmd = &exec.Cmd{Process: &os.Process{Pid: 0}}
	manager.Stop()
	if !rpc.stopped {
		t.Fatal("failed interrupt did not fall back to shutdown RPC")
	}
}
