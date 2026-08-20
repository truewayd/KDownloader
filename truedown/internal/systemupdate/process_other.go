//go:build !windows

package systemupdate

import "os/exec"

func configureHiddenProcess(command *exec.Cmd) {}
