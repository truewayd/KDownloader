//go:build !windows

package downloader

import (
	"os"
	"path/filepath"
)

func prepareDownloaderTestProcess() error {
	// macOS exposes its default temp root through /var -> /private/var.
	// Fixtures use the physical directory; link rejection is tested explicitly.
	directory, err := filepath.EvalSymlinks(os.TempDir())
	if err != nil {
		return err
	}
	return os.Setenv("TMPDIR", directory)
}
