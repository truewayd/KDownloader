//go:build !windows

package modulehost

import "os/exec"

func configureProcess(command *exec.Cmd) {}
