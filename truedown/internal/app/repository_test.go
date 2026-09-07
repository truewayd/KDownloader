package app

import (
	"os"
	"path/filepath"
	"testing"
)

// repositoryFile works under go test and the cross-compiled WSL runner.
func repositoryFile(t *testing.T, parts ...string) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return filepath.Join(append([]string{dir}, parts...)...)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("TrueDown repository root not found")
		}
		dir = parent
	}
}
