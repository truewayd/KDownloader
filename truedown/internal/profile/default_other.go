//go:build !windows && !linux && !darwin

package profile

import (
	"os"
	"path/filepath"
)

func DefaultDirectory() (string, error) {
	root, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "truedown"), nil
}
