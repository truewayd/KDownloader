//go:build !windows

package downloader

import (
	"fmt"
	"os/exec"
	"runtime"
)

func systemOpenPath(path string) error {
	command := "xdg-open"
	if runtime.GOOS == "darwin" {
		command = "open"
	}
	process := exec.Command(command, path)
	if err := process.Start(); err != nil {
		return fmt.Errorf("start %s: %w", command, err)
	}
	go func() { _ = process.Wait() }()
	return nil
}
