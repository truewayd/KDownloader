package downloader

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Walk relative to retained directory handles so a renamed parent cannot
// redirect cleanup. Root.Lstat captures handle identities on Windows too.
func openCleanupDirectory(folder string) (*os.Root, error) {
	return openCleanupDirectoryWith(folder, (*os.Root).OpenRoot)
}

func openCleanupDirectoryWith(folder string, openChild func(*os.Root, string) (*os.Root, error)) (*os.Root, error) {
	folder, err := filepath.Abs(folder)
	if err != nil {
		return nil, err
	}
	volume := filepath.VolumeName(folder)
	if os.PathSeparator == '\\' && (len(volume) != 2 || volume[1] != ':') {
		return nil, fmt.Errorf("partial cleanup requires a local drive directory")
	}
	base := volume + string(os.PathSeparator)
	relative, err := filepath.Rel(base, folder)
	if err != nil {
		return nil, err
	}
	parts := strings.Split(relative, string(os.PathSeparator))
	if len(parts) > 256 {
		return nil, fmt.Errorf("cleanup directory has too many components")
	}
	root, err := os.OpenRoot(base)
	if err != nil {
		return nil, err
	}
	for _, part := range parts {
		if part == "." {
			continue
		}
		info, err := root.Lstat(part)
		if err != nil {
			root.Close()
			return nil, err
		}
		if !info.IsDir() || cleanupIsLink(info) {
			root.Close()
			return nil, fmt.Errorf("cleanup directory contains a link or non-directory")
		}
		next, err := openChild(root, part)
		if err != nil {
			root.Close()
			return nil, err
		}
		opened, err := next.Stat(".")
		root.Close()
		if err != nil || !os.SameFile(info, opened) {
			next.Close()
			return nil, fmt.Errorf("cleanup directory changed while opening")
		}
		root = next
	}
	return root, nil
}

func removePartialPair(root *os.Root, name string) error {
	names := []string{name, name + ".aria2"}
	infos := make([]os.FileInfo, len(names))
	for i, entry := range names {
		info, err := root.Lstat(entry)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return fmt.Errorf("inspect partial download %q: %w", entry, err)
		}
		if !info.Mode().IsRegular() || cleanupIsLink(info) {
			return fmt.Errorf("refuse to remove non-file partial download %q", entry)
		}
		infos[i] = info
	}
	for i, info := range infos {
		if info == nil {
			continue
		}
		current, err := root.Lstat(names[i])
		if os.IsNotExist(err) {
			continue
		}
		if err != nil || !os.SameFile(info, current) || cleanupIsLink(current) {
			return fmt.Errorf("partial download %q changed before cleanup", names[i])
		}
		if err := root.Remove(names[i]); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove partial download %q: %w", names[i], err)
		}
	}
	return nil
}
