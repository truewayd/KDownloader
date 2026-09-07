//go:build windows

package startup

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const runKey = `Software\Microsoft\Windows\CurrentVersion\Run`

type runEntry struct{ name string }

func New(dataDir string) *Manager {
	executable, err := os.Executable()
	if err != nil {
		return &Manager{reason: "Cannot resolve the TrueDown executable."}
	}
	// Per-process environment settings cannot be reproduced by a login entry.
	for _, key := range []string{"TRUEDOWN_ADDR", "TRUEDOWN_TLS_CERT", "TRUEDOWN_TLS_KEY", "TRUEDOWN_REQUIRE_TOKEN", "TRUEDOWN_API_TOKEN", "TRUEDOWN_ARIA2_PATH"} {
		if os.Getenv(key) != "" {
			return &Manager{reason: "This instance uses environment overrides; configure startup through your service launcher."}
		}
	}
	command := windows.ComposeCommandLine([]string{executable, "background", "--data-dir", filepath.Clean(dataDir)})
	if len(utf16.Encode([]rune(command))) > 260 {
		return &Manager{reason: "The executable and data-directory paths exceed the Windows startup command limit."}
	}
	identity := sha256.Sum256([]byte(strings.ToLower(filepath.Clean(dataDir))))
	return &Manager{entry: runEntry{name: fmt.Sprintf("TrueDown-%x", identity[:8])}, command: command}
}

func (e runEntry) Read() (string, error) {
	key, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.QUERY_VALUE)
	if errors.Is(err, registry.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	defer key.Close()
	value, _, err := key.GetStringValue(e.name)
	if errors.Is(err, registry.ErrNotExist) {
		return "", nil
	}
	return value, err
}

func (e runEntry) Write(command string) error {
	key, _, err := registry.CreateKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	return key.SetStringValue(e.name, command)
}

func (e runEntry) Remove() error {
	key, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if errors.Is(err, registry.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer key.Close()
	err = key.DeleteValue(e.name)
	if errors.Is(err, registry.ErrNotExist) {
		return nil
	}
	return err
}
