package downloader

import (
	"encoding/json"
	"path/filepath"
	"strings"
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
	if json.Unmarshal([]byte(task.RequestJSON), &identity) != nil || identity.Name != "" || identity.BitTorrent != nil || len(identity.CollectionPath) > 0 {
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

// Expanded collections retain their remote hierarchy in either layout.
func (m *Manager) groupedRequestFolderLocked(identity requestIdentity) string {
	if len(identity.CollectionPath) > 0 && identity.collectionLayout != CollectionLayoutCategory {
		if directory := collectionModuleDirectory(identity.ModuleID); directory != "" {
			name := identity.CollectionPath[0]
			if len(identity.CollectionID) >= 16 {
				// Leave space for the disambiguator under both byte and UTF-16 path limits.
				for len(name) > 220 {
					_, size := utf8.DecodeLastRuneInString(name)
					name = name[:len(name)-size]
				}
				name = strings.TrimRight(name, " .") + " [" + identity.CollectionID[:16] + "]"
			}
			return filepath.Join(append([]string{identity.Folder, directory, name}, identity.CollectionPath[1:]...)...)
		}
	}
	folder := m.groupedFolderLocked(identity.Folder, identity.Name, identity.Link)
	return filepath.Join(append([]string{folder}, identity.CollectionPath...)...)
}

func collectionModuleDirectory(id string) string {
	switch id {
	case GoogleDriveModuleID:
		return "GoogleDrive"
	case DropboxModuleID:
		return "Dropbox"
	case "mega":
		return "MEGA"
	case MediaFireModuleID:
		return "MediaFire"
	case TelegraphModuleID:
		return "Telegraph"
	default:
		return ""
	}
}
