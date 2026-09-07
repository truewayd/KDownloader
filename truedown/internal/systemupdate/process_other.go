//go:build !windows

package systemupdate

import (
	"fmt"
	"os/exec"
)

func configureHiddenProcess(command *exec.Cmd) {}

func configureNativeHelper(command *exec.Cmd) {}
func nativeUpdateLock(string) (func(), bool, error) {
	return nil, false, fmt.Errorf("native automatic updates require Windows")
}
