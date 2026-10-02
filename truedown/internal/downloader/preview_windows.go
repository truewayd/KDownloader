//go:build windows

package downloader

import (
	"fmt"
	"golang.org/x/sys/windows"
	"os"
)

func openPreviewFile(path string) (*os.File, func(), error) {
	release, err := lockPathOpenTarget(path)
	if err != nil {
		return nil, nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		release()
		return nil, nil, err
	}
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(windows.Handle(file.Fd()), &info); err != nil || info.NumberOfLinks != 1 {
		file.Close()
		release()
		return nil, nil, fmt.Errorf("preview refuses hard links")
	}
	return file, release, nil
}
