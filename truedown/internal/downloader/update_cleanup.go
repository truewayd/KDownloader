package downloader

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// CleanupUpdateDownloads is internal to the updater. It accepts a verified
// receipt, never an HTTP/IPC path, and serializes with retry/removal/admission.
func (m *Manager) CleanupUpdateDownloads(directory, name, digest string, size int64) error {
	decoded, err := hex.DecodeString(digest)
	if err != nil || len(decoded) != sha256.Size || size <= 0 || size > 256<<20 ||
		name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\:`) || !filepath.IsAbs(directory) {
		return fmt.Errorf("invalid update cleanup receipt")
	}
	m.opMu.Lock()
	defer m.opMu.Unlock()
	info, err := os.Lstat(directory)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("update download root must be an ordinary directory")
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return err
	}
	defer root.Close()
	listing, err := root.Open(".")
	if err != nil {
		return err
	}
	entries, readErr := listing.ReadDir(4097)
	listing.Close()
	if readErr != nil && readErr != io.EOF {
		return readErr
	}
	if len(entries) > 4096 {
		return fmt.Errorf("too many managed update download directories")
	}
	candidates := map[string]*Task{}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "download-") && entry.IsDir() && entry.Type()&os.ModeSymlink == 0 {
			candidates[entry.Name()] = nil
			// Ordinary tasks use one optional file-group subdirectory.
			child, err := root.Open(entry.Name())
			if err != nil {
				return err
			}
			groups, readErr := child.ReadDir(129)
			child.Close()
			if readErr != nil && readErr != io.EOF {
				return readErr
			}
			if len(groups) > 128 {
				return fmt.Errorf("too many update file groups")
			}
			for _, group := range groups {
				if group.IsDir() && group.Type()&os.ModeSymlink == 0 {
					candidates[filepath.Join(entry.Name(), group.Name())] = nil
				}
			}
		}
	}
	m.mu.RLock()
	for _, task := range m.tasks {
		relative, err := filepath.Rel(directory, task.Folder)
		parts := strings.Split(relative, string(filepath.Separator))
		if err == nil && len(parts) <= 2 && strings.HasPrefix(parts[0], "download-") && samePathName(task.OutputName, name) {
			candidates[relative] = cloneTask(task)
		}
	}
	m.mu.RUnlock()
	var failures []error
	for folder, task := range candidates {
		if err := m.cleanupUpdateOutput(root, directory, folder, name, digest, size, task); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func (m *Manager) cleanupUpdateOutput(root *os.Root, directory, folder, name, digest string, size int64, task *Task) error {
	id := int64(0)
	if task != nil {
		if task.Status != StatusDone {
			return fmt.Errorf("update task %d is not completed", task.ID)
		}
		id = task.ID
	}
	m.mu.RLock()
	owner, conflict := m.conflictingOutputOwnerLocked(filepath.Join(directory, folder), name, id)
	m.mu.RUnlock()
	if conflict {
		return fmt.Errorf("update output overlaps task %d", owner)
	}
	for current := folder; current != "."; current = filepath.Dir(current) {
		info, err := root.Lstat(current)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		if err == nil && (!info.IsDir() || info.Mode()&os.ModeSymlink != 0) {
			return fmt.Errorf("update download directory was replaced")
		}
	}
	info, err := root.Lstat(folder)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("update download directory was replaced")
		}
		files, err := root.OpenRoot(folder)
		if err != nil {
			return err
		}
		if _, err := files.Lstat(name); os.IsNotExist(err) && task == nil {
			files.Close()
			return nil
		}
		err = removeVerifiedUpdateOutput(files, name, digest, size, task != nil)
		files.Close()
		if err != nil {
			return err
		}
		// Remove only an empty owned directory, never unrelated contents.
		_ = root.Remove(folder)
		if parent := filepath.Dir(folder); parent != "." {
			_ = root.Remove(parent)
		}
	}
	if task != nil {
		if err := m.store.DeleteBatch([]int64{id}); err != nil {
			return err
		}
		m.mu.Lock()
		m.removeTaskLocked(id)
		m.compactOrderedIDsLocked()
		m.mu.Unlock()
	}
	return nil
}

func removeVerifiedUpdateOutput(root *os.Root, name, digest string, size int64, knownTask bool) error {
	var payload os.FileInfo
	for _, file := range []string{name, name + ".aria2"} {
		info, err := root.Lstat(file)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("update output must be a regular file")
		}
		if file == name {
			payload = info
		}
	}
	if payload == nil && !knownTask {
		return nil
	}
	if payload != nil {
		if payload.Size() != size {
			return fmt.Errorf("update output size changed; preserving it")
		}
		file, err := root.Open(name)
		if err != nil {
			return err
		}
		hash := sha256.New()
		count, copyErr := io.Copy(hash, io.LimitReader(file, size+1))
		file.Close()
		if copyErr != nil || count != size || hex.EncodeToString(hash.Sum(nil)) != digest {
			return fmt.Errorf("update output checksum changed; preserving it")
		}
	}
	for _, file := range []string{name + ".aria2", name} {
		if err := root.Remove(file); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}
