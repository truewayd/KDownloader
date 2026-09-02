//go:build !windows

package main

import (
	"os/exec"
	"runtime"
)

func startPlatformApp() (*platformApp, error) {
	return &platformApp{}, nil
}

func openPlatformPath(path string) error {
	command := "xdg-open"
	if runtime.GOOS == "darwin" {
		command = "open"
	}
	process := exec.Command(command, path)
	if err := process.Start(); err != nil {
		return err
	}
	go func() { _ = process.Wait() }()
	return nil
}
