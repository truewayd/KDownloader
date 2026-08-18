//go:build windows

package downloader

import "os/exec"

func systemOpenPath(path string) error {
	return exec.Command("explorer.exe", path).Start()
}
