//go:build windows

package profile

import (
	"fmt"
	"golang.org/x/sys/windows"
	"path/filepath"
)

// Known Folder resolution honors Windows folder redirection.
func DefaultDirectory() (string, error) {
	root, err := windows.KnownFolderPath(windows.FOLDERID_LocalAppData, 0)
	if err != nil {
		return "", fmt.Errorf("resolve Windows local application data: %w", err)
	}
	return filepath.Join(root, "TrueDown"), nil
}
