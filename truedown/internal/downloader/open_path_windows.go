//go:build windows

package downloader

import (
	"os/exec"
	"syscall"
)

func systemOpenPath(path string) error {
	command := exec.Command("explorer.exe", path)
	// User-opened Explorer windows belong to the user session, outside the
	// console core's process-lifetime job. Managed download engines stay inside.
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x01000000}
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}
