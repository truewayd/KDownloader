//go:build windows

package app

import (
	"golang.org/x/sys/windows"
	"os"
)

func attachParentConsole() {
	// GUI releases inherit redirected handles; attach only missing console handles.
	attach := windows.NewLazySystemDLL("kernel32.dll").NewProc("AttachConsole")
	_, _, _ = attach.Call(uintptr(uint32(0xffffffff)))
	for _, stream := range []struct {
		file **os.File
		name string
		mode int
	}{
		{&os.Stdin, "CONIN$", os.O_RDONLY},
		{&os.Stdout, "CONOUT$", os.O_WRONLY},
		{&os.Stderr, "CONOUT$", os.O_WRONLY},
	} {
		if _, err := (*stream.file).Stat(); err == nil {
			continue
		}
		if file, err := os.OpenFile(stream.name, stream.mode, 0); err == nil {
			*stream.file = file
		}
	}
}
