package downloader

import (
	"encoding/json"
	"path/filepath"
	"unicode/utf8"
)

func defaultGroupDirectory(group FileGroup) string {
	if directory := map[string]string{
		"image": "Pictures", "video": "Videos", "audio": "Music", "archive": "Archives",
		"application": "Applications", "document": "Documents", "project": "Projects", "other": "Other",
	}[group.ID]; directory != "" {
		return directory
	}
	directory := sanitizeModulePathComponent(group.Name)
	if directory == "" {
		return group.ID
	}
	return directory
}

// Resolvers can discover a filename before aria2 opens any output file. Only
// complete that first directory choice; never relocate admitted or old tasks.
func (m *Manager) resolveGroupDirectoryLocked(task *Task, name string) {
	if task.OutputName != "" || task.CompletedLength != 0 || m.ariaAdmitted[task.ID] {
		return
	}
	var identity requestIdentity
	if json.Unmarshal([]byte(task.RequestJSON), &identity) != nil || identity.Name != "" || identity.BitTorrent != nil {
		return
	}
	if samePathName(task.Folder, identity.Folder) || !samePathName(task.Folder, m.groupedFolderLocked(identity.Folder, task.Name, task.Link)) {
		return
	}
	folder := m.groupedFolderLocked(identity.Folder, name, task.Link)
	if len(folder) <= 4096 {
		task.Folder = folder
	}
}

func validGroupDirectory(directory string) bool {
	return directory != "" && directory != "." && directory != ".." &&
		utf8.RuneCountInString(directory) <= 80 && sanitizeModulePathComponent(directory) == directory
}

// Request identities keep the caller's root. Only a fresh task gets a grouped
// output directory, so duplicates and restored tasks retain their saved paths.
// The caller holds m.mu; resolving a group never creates or moves files.
func (m *Manager) groupedFolderLocked(folder, name, link string) string {
	category := m.classifyTask(&Task{Name: name, Link: link})
	groups := m.fileGroups.Groups
	if groups == nil {
		groups = defaultFileGroups().Groups
	}
	for _, group := range groups {
		if group.ID != category {
			continue
		}
		directory := group.Directory
		if directory == "" {
			directory = defaultGroupDirectory(group)
		}
		// Renewed URLs may supply a task's actual output folder.
		if samePathName(filepath.Base(folder), directory) {
			return folder
		}
		return filepath.Join(folder, directory)
	}
	return filepath.Join(folder, "Other")
}
