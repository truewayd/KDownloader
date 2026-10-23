package downloader

import (
	"fmt"
	"os"
)

// Call under mu and opMu immediately before destructive HTTP cleanup. The
// lexical reservations protect absent files; identities also catch aliases
// (including Windows short names and hard links) of existing output pairs.
func (m *Manager) checkPhysicalOutputOwnershipLocked(task *Task, root *os.Root) error {
	dir, err := root.Stat(".")
	if err != nil {
		return err
	}
	names := []string{task.OutputName, task.OutputName + ".aria2"}
	var files []os.FileInfo
	for _, name := range names {
		info, err := root.Stat(name)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		if err == nil {
			files = append(files, info)
		}
	}
	for _, other := range m.tasks {
		if other.ID == task.ID || other.OutputName == "" {
			continue
		}
		otherRoot, err := os.OpenRoot(other.Folder)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return fmt.Errorf("cannot verify output owner %d: %w", other.ID, err)
		}
		conflict, inspectErr := func() (bool, error) {
			defer otherRoot.Close()
			otherDir, err := otherRoot.Stat(".")
			if err != nil {
				return false, err
			}
			for _, otherName := range []string{other.OutputName, other.OutputName + ".aria2"} {
				if os.SameFile(dir, otherDir) {
					for _, name := range names {
						if outputNameKey("", name) == outputNameKey("", otherName) {
							return true, nil
						}
					}
				}
				info, err := otherRoot.Stat(otherName)
				if os.IsNotExist(err) {
					continue
				}
				if err != nil {
					return false, err
				}
				for _, file := range files {
					if os.SameFile(file, info) {
						return true, nil
					}
				}
			}
			return false, nil
		}()
		if inspectErr != nil {
			return fmt.Errorf("cannot verify output owner %d: %w", other.ID, inspectErr)
		}
		if conflict {
			return fmt.Errorf("partial output belongs to task %d through a filesystem alias", other.ID)
		}
	}
	return nil
}

func (m *Manager) reserveOutputLocked(dir, name string, id int64) {
	key := outputNameKey(dir, name)
	owners := m.outputNames[key]
	if owners == nil {
		owners = make(map[int64]struct{})
		m.outputNames[key] = owners
	}
	owners[id] = struct{}{}
}

func (m *Manager) releaseOutputLocked(dir, name string, id int64) {
	key := outputNameKey(dir, name)
	owners := m.outputNames[key]
	delete(owners, id)
	if len(owners) == 0 {
		delete(m.outputNames, key)
	}
}
