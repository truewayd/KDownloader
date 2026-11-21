//go:build !windows

package systemupdate

import (
	"fmt"
	"os/exec"
	"time"
)

func configureHiddenProcess(command *exec.Cmd) {}

func configureNativeHelper(command *exec.Cmd) {}

type nativeOpenEvent struct{}

func openNativeEvent(string) (nativeOpenEvent, error) {
	return nativeOpenEvent{}, fmt.Errorf("native automatic updates require Windows")
}
func (nativeOpenEvent) inherit(*exec.Cmd) {}
func (nativeOpenEvent) requested() bool   { return false }
func (nativeOpenEvent) close()            {}
func retryableNativeReplace(error) bool   { return false }
func captureNativeExitProcesses(string) (*nativeExitProcesses, error) {
	return nil, fmt.Errorf("native automatic updates require Windows")
}
func awaitNativeExit(*nativeExitProcesses, time.Duration) error {
	return fmt.Errorf("native automatic updates require Windows")
}
func nativeUpdateLock(string) (func(), bool, error) {
	return nil, false, fmt.Errorf("native automatic updates require Windows")
}
