//go:build !windows

package profile

import (
	"os"
	"path/filepath"
	"runtime"
)

// DefaultDownloadDirectory is independent of the application profile location.
func DefaultDownloadDirectory() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if runtime.GOOS == "linux" {
		config := os.Getenv("XDG_CONFIG_HOME")
		if !filepath.IsAbs(config) {
			config = filepath.Join(home, ".config")
		}
		data, err := os.ReadFile(filepath.Join(config, "user-dirs.dirs"))
		if err == nil {
			return parseDownloadDirectory(string(data), home), nil
		}
		if !os.IsNotExist(err) {
			return "", err
		}
	}
	return filepath.Join(home, "Downloads"), nil
}
