package safefile

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sync"
)

// The caller owns and trusts the parent directory. These helpers protect the
// managed leaf and backup entries; they intentionally allow a configured data
// directory itself to be a junction or symlink.
var operationMu sync.Mutex

// ReadFile reads a regular file with a hard size limit. If an atomic write was
// interrupted after preserving the previous file, the backup is recovered.
func ReadFile(path string, maximum int64) ([]byte, error) {
	operationMu.Lock()
	defer operationMu.Unlock()

	data, err := readFile(path, maximum)
	if !os.IsNotExist(err) {
		return data, err
	}
	if err := restoreBackup(path); err != nil {
		return nil, err
	}
	return readFile(path, maximum)
}

func readFile(path string, maximum int64) ([]byte, error) {
	return readFileWithOpener(path, maximum, os.Open)
}

func readFileWithOpener(path string, maximum int64, openFile func(string) (*os.File, error)) ([]byte, error) {
	if maximum < 1 {
		return nil, fmt.Errorf("file size limit must be positive")
	}
	pathInfo, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if pathInfo.Mode()&os.ModeSymlink != 0 || !pathInfo.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", path)
	}
	if err := freezeFileIdentity(pathInfo); err != nil {
		return nil, err
	}
	file, err := openFile(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || !os.SameFile(pathInfo, info) {
		return nil, fmt.Errorf("%s is not a regular file", path)
	}
	if info.Size() > maximum {
		return nil, fmt.Errorf("%s exceeds %d bytes", path, maximum)
	}
	data, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maximum {
		return nil, fmt.Errorf("%s exceeds %d bytes", path, maximum)
	}
	return data, nil
}

// WriteFile replaces a file only after its same-directory temporary file has
// been written and synchronized. The previous version is restored on failure.
func WriteFile(path string, data []byte, mode os.FileMode) error {
	operationMu.Lock()
	defer operationMu.Unlock()

	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	if _, err := os.Lstat(path); os.IsNotExist(err) {
		if backupErr := restoreBackup(path); backupErr != nil && !os.IsNotExist(backupErr) {
			return backupErr
		}
	} else if err != nil {
		return err
	}
	var previousInfo os.FileInfo
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return fmt.Errorf("refuse to replace non-regular file %s", path)
		}
		if err := freezeFileIdentity(info); err != nil {
			return err
		}
		previousInfo = info
	} else if !os.IsNotExist(err) {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".truedown-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	closeTemporary := func() {
		_ = temporary.Close()
	}
	if err := temporary.Chmod(mode); err != nil {
		closeTemporary()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		closeTemporary()
		return err
	}
	if err := temporary.Sync(); err != nil {
		closeTemporary()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}

	backupPath := path + ".bak"
	if backupInfo, err := os.Lstat(backupPath); err == nil {
		if backupInfo.Mode()&os.ModeSymlink != 0 || !backupInfo.Mode().IsRegular() {
			return fmt.Errorf("refuse to remove non-regular backup file %s", backupPath)
		}
		if err := os.Remove(backupPath); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if previousInfo != nil {
		if err := renameChecked(path, backupPath, previousInfo); err != nil {
			restoreMovedEntry(backupPath, path)
			return err
		}
	}
	temporaryInfo, err := os.Lstat(temporaryPath)
	if err != nil {
		restoreMovedEntry(backupPath, path)
		return err
	}
	if err := freezeFileIdentity(temporaryInfo); err != nil {
		restoreMovedEntry(backupPath, path)
		return err
	}
	if err := renameChecked(temporaryPath, path, temporaryInfo); err != nil {
		restoreMovedEntry(backupPath, path)
		return err
	}
	if err := syncDirectory(directory); err != nil {
		return err
	}
	if backupInfo, err := os.Lstat(backupPath); err == nil && previousInfo != nil && os.SameFile(previousInfo, backupInfo) {
		_ = os.Remove(backupPath)
	}
	_ = syncDirectory(directory)
	return nil
}

// RemoveFile removes a managed regular file and its atomic-write backup. Both
// leaf entries are validated before either one is changed.
func RemoveFile(path string) error {
	operationMu.Lock()
	defer operationMu.Unlock()

	entries := []string{path + ".bak", path}
	exists := make([]bool, len(entries))
	for index, entry := range entries {
		info, err := os.Lstat(entry)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return fmt.Errorf("refuse to remove non-regular file %s", entry)
		}
		exists[index] = true
	}
	removed := false
	for index, entry := range entries {
		if exists[index] {
			if err := os.Remove(entry); err != nil {
				return err
			}
			removed = true
		}
	}
	if !removed {
		return nil
	}
	return syncDirectory(filepath.Dir(path))
}

func restoreBackup(path string) error {
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return fmt.Errorf("%s is not a regular file", path)
		}
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}

	backupPath := path + ".bak"
	info, err := os.Lstat(backupPath)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file", backupPath)
	}
	if err := freezeFileIdentity(info); err != nil {
		return err
	}
	if err := renameChecked(backupPath, path, info); err != nil {
		restoreMovedEntry(path, backupPath)
		return err
	}
	return syncDirectory(filepath.Dir(path))
}

func renameChecked(source, destination string, expected os.FileInfo) error {
	if err := freezeFileIdentity(expected); err != nil {
		return err
	}
	if err := os.Rename(source, destination); err != nil {
		return err
	}
	actual, err := os.Lstat(destination)
	if err != nil {
		return err
	}
	if actual.Mode()&os.ModeSymlink != 0 || !actual.Mode().IsRegular() || !os.SameFile(expected, actual) {
		return fmt.Errorf("file changed while renaming %s", source)
	}
	return nil
}

func freezeFileIdentity(info os.FileInfo) error {
	if !os.SameFile(info, info) {
		return fmt.Errorf("could not identify regular file %s", info.Name())
	}
	return nil
}

func restoreMovedEntry(source, destination string) {
	if _, err := os.Lstat(destination); !os.IsNotExist(err) {
		return
	}
	_ = os.Rename(source, destination)
}

func syncDirectory(path string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
