//go:build !windows

package app

import "os/exec"

func configureRelaunchProcess(command *exec.Cmd) {}
