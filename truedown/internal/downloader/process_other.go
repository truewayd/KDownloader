//go:build !windows

package downloader

import "os/exec"

func configureManagedProcess(command *exec.Cmd) {}
