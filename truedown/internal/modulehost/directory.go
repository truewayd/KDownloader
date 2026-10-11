package modulehost

import (
	"os"
	"path/filepath"
	"strings"
)

// MakeDirectory rejects symlink/reparse aliases before creating child paths.
func MakeDirectory(path string) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return ErrPackage
	}
	volume := filepath.VolumeName(path)
	current := volume + string(filepath.Separator)
	for _, part := range strings.Split(strings.TrimPrefix(path, current), string(filepath.Separator)) {
		if part == "" {
			continue
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if os.IsNotExist(err) {
			if err = os.Mkdir(current, 0700); err != nil && !os.IsExist(err) {
				return err
			}
			info, err = os.Lstat(current)
		}
		if err != nil {
			return err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return ErrPackage
		}
	}
	return nil
}
