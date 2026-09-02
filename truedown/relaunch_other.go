//go:build !windows

package main

import "os/exec"

func configureRelaunchProcess(command *exec.Cmd) {}
