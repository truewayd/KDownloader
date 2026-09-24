//go:build windows

package downloader

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestManagedProcessDoesNotCreateAConsoleWindow(t *testing.T) {
	command := exec.Command("aria2c.exe", "--version")
	configureManagedProcess(command)
	if command.SysProcAttr == nil || !command.SysProcAttr.HideWindow || command.SysProcAttr.CreationFlags&0x08000000 == 0 {
		t.Fatal("managed aria2 process is not configured for hidden execution")
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
