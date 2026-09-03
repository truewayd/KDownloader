//go:build linux || darwin

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

func defaultDataDir(_ string) (string, error) {
	if runtime.GOOS == "darwin" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve macOS application data directory: %w", err)
		}
		return filepath.Join(home, "Library", "Application Support", "TrueDown"), nil
	}
	if dataHome := strings.TrimSpace(os.Getenv("XDG_DATA_HOME")); dataHome != "" && filepath.IsAbs(dataHome) {
		return filepath.Join(dataHome, "truedown"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve Linux application data directory: %w", err)
	}
	return filepath.Join(home, ".local", "share", "truedown"), nil
}
