//go:build !windows

package downloader

import (
	"fmt"
	"golang.org/x/sys/unix"
	"os"
	"strings"
)

func openPreviewFile(path string) (*os.File, func(), error) {
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, nil, err
	}
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	for i, part := range parts {
		flags := unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_CLOEXEC | unix.O_NONBLOCK
		if i < len(parts)-1 {
			flags |= unix.O_DIRECTORY
		}
		next, openErr := unix.Openat(fd, part, flags, 0)
		unix.Close(fd)
		if openErr != nil {
			return nil, nil, openErr
		}
		fd = next
	}
	var info unix.Stat_t
	if err := unix.Fstat(fd, &info); err != nil || info.Nlink != 1 {
		unix.Close(fd)
		return nil, nil, fmt.Errorf("preview refuses hard links")
	}
	return os.NewFile(uintptr(fd), path), func() {}, nil
}
