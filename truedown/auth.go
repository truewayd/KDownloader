package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type authController struct {
	mu           sync.RWMutex
	dataDir      string
	settingsPath string
	tokenPath    string
	enabled      bool
	token        string
	managed      bool
	locked       bool
}

type persistedAuthSettings struct {
	Enabled bool `json:"enabled"`
}

func newAuthController(dataDir string, required bool, configured string) (*authController, error) {
	controller := &authController{
		dataDir:      dataDir,
		settingsPath: filepath.Join(dataDir, "truedown.auth.json"),
		managed:      required || strings.TrimSpace(configured) != "",
	}
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return nil, fmt.Errorf("create TrueDown data directory: %w", err)
	}
	controller.enabled = controller.managed
	if !controller.managed {
		data, err := os.ReadFile(controller.settingsPath)
		if err == nil {
			var settings persistedAuthSettings
			if err := json.Unmarshal(data, &settings); err != nil {
				return nil, fmt.Errorf("read TrueDown auth settings: %w", err)
			}
			controller.enabled = settings.Enabled
		} else if !os.IsNotExist(err) {
			return nil, fmt.Errorf("read TrueDown auth settings: %w", err)
		}
	}
	if controller.enabled {
		token, tokenPath, err := loadOrCreateAPIToken(dataDir, configured)
		if err != nil {
			return nil, err
		}
		controller.token = token
		controller.tokenPath = tokenPath
	}
	return controller, nil
}

func (controller *authController) Snapshot() (enabled bool, token string, managed bool) {
	controller.mu.RLock()
	defer controller.mu.RUnlock()
	return controller.enabled, controller.token, controller.managed || controller.locked
}

func (controller *authController) SetEnabled(enabled bool) (string, error) {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if (controller.managed || controller.locked) && enabled != controller.enabled {
		return "", fmt.Errorf("API Key authentication is managed by the TrueDown runtime")
	}
	if enabled == controller.enabled {
		return controller.token, nil
	}
	var token, tokenPath string
	if enabled {
		var err error
		token, tokenPath, err = loadOrCreateAPIToken(controller.dataDir, "")
		if err != nil {
			return "", err
		}
	}
	data, err := json.Marshal(persistedAuthSettings{Enabled: enabled})
	if err != nil {
		return "", fmt.Errorf("encode TrueDown auth settings: %w", err)
	}
	if err := os.WriteFile(controller.settingsPath, append(data, '\n'), 0600); err != nil {
		return "", fmt.Errorf("write TrueDown auth settings: %w", err)
	}
	controller.enabled = enabled
	if enabled {
		controller.token = token
		controller.tokenPath = tokenPath
	}
	return controller.token, nil
}

func (controller *authController) LockEnabled() {
	controller.mu.Lock()
	controller.locked = true
	controller.mu.Unlock()
}

func (controller *authController) TokenPath() string {
	controller.mu.RLock()
	defer controller.mu.RUnlock()
	return controller.tokenPath
}
