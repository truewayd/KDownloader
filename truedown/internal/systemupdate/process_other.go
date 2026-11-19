//go:build !windows

package systemupdate

import (
	"fmt"
	"os/exec"
	"time"
)

func configureHiddenProcess(command *exec.Cmd) {}

func configureNativeHelper(command *exec.Cmd) {}
func captureNativeExitProcesses(string) (*nativeExitProcesses, error) {
	return nil, fmt.Errorf("native automatic updates require Windows")
}
func awaitNativeExit(*nativeExitProcesses, time.Duration) error {
	return fmt.Errorf("native automatic updates require Windows")
}
func nativeUpdateLock(string) (func(), bool, error) {
	return nil, false, fmt.Errorf("native automatic updates require Windows")
}
