//go:build !windows

package enginesignal

import (
	"fmt"
	"os"
)

func Interrupt(process *os.Process) error {
	if process == nil {
		return fmt.Errorf("engine process unavailable")
	}
	return process.Signal(os.Interrupt)
}

func RunHelper(args []string) (bool, error) { return false, nil }
