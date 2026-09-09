//go:build !windows

package app

import (
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

func desktopInput(input *os.File) (*os.File, error) {
	// Inherited stdin may be blocking. Closing that os.File cannot interrupt
	// an active read, so shutdown would wait for the shell to close its writer.
	fd, err := unix.FcntlInt(input.Fd(), unix.F_DUPFD_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("duplicate desktop input: %w", err)
	}
	if err := unix.SetNonblock(fd, true); err != nil {
		unix.Close(fd)
		return nil, fmt.Errorf("prepare cancellable desktop input: %w", err)
	}
	return os.NewFile(uintptr(fd), "desktop-input"), nil
}
