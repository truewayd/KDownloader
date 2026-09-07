//go:build linux || darwin

package profile

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

func DefaultDirectory() (string, error) {
	if runtime.GOOS == "linux" {
		if root := os.Getenv("XDG_DATA_HOME"); root != "" && filepath.IsAbs(root) {
			return filepath.Join(root, "truedown"), nil
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve application data directory: %w", err)
	}
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "Application Support", "TrueDown"), nil
	}
	return filepath.Join(home, ".local", "share", "truedown"), nil
}
