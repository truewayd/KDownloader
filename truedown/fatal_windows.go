//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

var messageBoxW = syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")

func showFatalError(err error) {
	detailRunes := []rune(err.Error())
	if len(detailRunes) > 4096 {
		detailRunes = append(detailRunes[:4096], '.', '.', '.')
	}
	detail := string(detailRunes)
	message, messageErr := syscall.UTF16PtrFromString("TrueDown could not start or continue:\n\n" + detail + "\n\nIf available, see truedown.log for details.")
	if messageErr != nil {
		return
	}
	title, titleErr := syscall.UTF16PtrFromString("TrueDown")
	if titleErr != nil {
		return
	}
	messageBoxW.Call(0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), 0x00000010|0x00010000)
}
