//go:build windows

package app

import (
	"os/exec"
	"syscall"
)

func configureRelaunchProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{
		HideWindow: true,
		// The old core closes its kill-on-close job during exit. The replacement
		// establishes its own job before starting aria2 and must survive that exit.
		CreationFlags: 0x08000000 | 0x01000000, // CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB
	}
}
