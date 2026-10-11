package modulebundle

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"truedown/internal/updatecache"
)

// Cleanup runs only at manager startup, before any baseline process is used.
// The embedded digest remains authoritative even when an update is selected.
func Cleanup(root, id string) error {
	data, err := assets.ReadFile("assets/" + id + "-" + runtime.GOOS + "-" + runtime.GOARCH + ".bin")
	if err != nil || len(data) == 0 {
		return nil
	}
	keep := fmt.Sprintf("%x", sha256.Sum256(data))
	directory, err := updatecache.Open(filepath.Join(root, "baseline"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer directory.Close()
	entries, err := updatecache.Entries(directory)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		digest, err := hex.DecodeString(name)
		if err != nil || len(digest) != sha256.Size || hex.EncodeToString(digest) != name || name == keep {
			continue
		}
		info, err := directory.Lstat(name)
		if err != nil || time.Since(info.ModTime()) < 24*time.Hour {
			continue
		}
		if err := updatecache.RemoveFlat(directory, name, func(file string) bool {
			return file == "provider" && runtime.GOOS != "windows" || file == "provider.exe" && runtime.GOOS == "windows"
		}); err != nil {
			return err
		}
	}
	return nil
}
