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
	if err := exec.Command(command, path).Start(); err != nil {
		return fmt.Errorf("start %s: %w", command, err)
	}
	return nil
}
