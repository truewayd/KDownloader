// Package updatecache bounds cleanup to updater-owned, flat directories.
package updatecache

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func Open(path string) (*os.Root, error) {
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("update cache requires an absolute path")
	}
	for parent := filepath.Clean(path); ; parent = filepath.Dir(parent) {
		info, err := os.Lstat(parent)
		if err != nil {
			return nil, err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("update cache traverses a directory alias")
		}
		if filepath.Dir(parent) == parent {
			break
		}
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("update cache is not an ordinary directory")
	}
	return os.OpenRoot(path)
}

func Entries(root *os.Root) ([]os.DirEntry, error) {
	f, err := root.Open(".")
	if err != nil {
		return nil, err
	}
	defer f.Close()
	entries, err := f.ReadDir(4097)
	if err != nil && err != io.EOF {
		return nil, err
	}
	if len(entries) > 4096 {
		return nil, fmt.Errorf("update cache exceeds cleanup entry limit")
	}
	return entries, nil
}

// RemoveFlat never recurses, follows a child link, or removes foreign contents.
// Inspect the complete set before removing anything; missing owned files permit
// retry after an interruption between individual removals.
func RemoveFlat(root *os.Root, name string, allowed func(string) bool) error {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\:`) {
		return fmt.Errorf("invalid cache directory")
	}
	info, err := root.Lstat(name)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("cache directory was replaced")
	}
	child, err := root.OpenRoot(name)
	if err != nil {
		return err
	}
	defer child.Close()
	entries, err := Entries(child)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		info, err := child.Lstat(entry.Name())
		if err != nil {
			return err
		}
		if !allowed(entry.Name()) || !info.Mode().IsRegular() {
			return fmt.Errorf("cache contains unowned or non-regular entries")
		}
	}
	for _, entry := range entries {
		if err := child.Remove(entry.Name()); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	child.Close()
	return root.Remove(name)
}
