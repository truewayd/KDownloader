//go:build !windows

package downloader

import "os"

func cleanupIsLink(info os.FileInfo) bool { return info.Mode()&os.ModeSymlink != 0 }
