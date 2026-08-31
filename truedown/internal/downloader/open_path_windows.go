//go:build windows

package downloader

import "os/exec"

func systemOpenPath(path string) error {
	command := exec.Command("explorer.exe", path)
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}
