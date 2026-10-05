//go:build !windows

package systemupdate

import "os/exec"

func configureInstallerProcess(command *exec.Cmd, directory string) {}
