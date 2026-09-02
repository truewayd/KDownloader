//go:build windows

package downloader

import (
	"os/exec"
	"testing"
)

func TestManagedProcessDoesNotCreateAConsoleWindow(t *testing.T) {
	command := exec.Command("aria2c.exe", "--version")
	configureManagedProcess(command)
	if command.SysProcAttr == nil || !command.SysProcAttr.HideWindow || command.SysProcAttr.CreationFlags&0x08000000 == 0 {
		t.Fatal("managed aria2 process is not configured for hidden execution")
	}
}
