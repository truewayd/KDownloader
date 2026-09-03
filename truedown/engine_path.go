package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

const aria2PathEnv = "TRUEDOWN_ARIA2_PATH"

func resolveStableAria2(base string) (string, error) {
	if configured := strings.TrimSpace(os.Getenv(aria2PathEnv)); configured != "" {
		return validateAria2Path(configured)
	}

	candidates := []string{filepath.Join(base, "aria2c")}
	if runtime.GOOS == "windows" {
		candidates = []string{
			filepath.Join(base, "aria2c.exe"),
			filepath.Join(base, "aria2", "aria2c.exe"),
		}
	} else {
		candidates = append(candidates, filepath.Join(base, "aria2", "aria2c"))
		if runtime.GOOS == "darwin" {
			candidates = append(candidates,
				filepath.Join(base, "..", "Resources", "aria2c"),
				"/opt/homebrew/bin/aria2c",
				"/usr/local/bin/aria2c",
			)
		}
	}
	for _, candidate := range candidates {
		if path, err := validateAria2Path(candidate); err == nil {
			return path, nil
		}
	}
	if runtime.GOOS != "windows" {
		if path, err := exec.LookPath("aria2c"); err == nil {
			return validateAria2Path(path)
		}
	}
	return "", fmt.Errorf("locate aria2: install aria2 or set %s to its executable", aria2PathEnv)
}

func validateAria2Path(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve aria2 executable: %w", err)
	}
	absolute = filepath.Clean(absolute)
	info, err := os.Stat(absolute)
	if err != nil {
		return "", fmt.Errorf("inspect aria2 executable: %w", err)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("aria2 executable is not a regular file: %s", absolute)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
		return "", fmt.Errorf("aria2 executable is not executable: %s", absolute)
	}
	return absolute, nil
}
