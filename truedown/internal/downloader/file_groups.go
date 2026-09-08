package downloader

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

const maxFileGroupsBytes = 64 * 1024

var ErrFileGroupsConflict = errors.New("file groups changed; reload before saving")
var groupIDPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)
var groupSuffixPattern = regexp.MustCompile(`^\.[a-z0-9]{1,16}(\.[a-z0-9]{1,16}){0,3}$`)

var defaultFileGroupIndex = indexFileGroups(defaultFileGroups().Groups)

func indexFileGroups(groups []FileGroup) map[string]string {
	index := make(map[string]string)
	for _, group := range groups {
		for _, suffix := range group.Extensions {
			index[suffix] = group.ID
		}
	}
	return index
}

type FileGroup struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Extensions []string `json:"extensions"`
	Icon       string   `json:"icon,omitempty"`
	Directory  string   `json:"directory"`
}

type FileGroupsSnapshot struct {
	Revision uint64          `json:"revision"`
	Groups   []FileGroup     `json:"groups"`
	Icons    []FileGroupIcon `json:"icons,omitempty"`
}

func defaultFileGroups() FileGroupsSnapshot {
	state := FileGroupsSnapshot{Groups: []FileGroup{
		{"image", "\u56fe\u7247", strings.Fields(".jpg .jpeg .png .gif .webp .avif .heic .heif .bmp .tif .tiff .svg .ico"), "", ""},
		{"video", "\u89c6\u9891", strings.Fields(".mp4 .mkv .webm .mov .avi .m4v .wmv .flv .mpg .mpeg .ts .m2ts .3gp"), "", ""},
		{"audio", "\u97f3\u4e50", strings.Fields(".mp3 .wav .flac .aac .m4a .ogg .opus .wma .aiff .alac .mid .midi"), "", ""},
		{"archive", "\u538b\u7f29\u5305", strings.Fields(".zip .rar .7z .tar .gz .bz2 .xz .zst .tgz .tbz2 .txz .iso .cab .lz .lzma"), "", ""},
		{"application", "\u5e94\u7528", strings.Fields(".exe .msi .msix .appx .appxbundle .msixbundle .apk .aab .dmg .pkg .deb .rpm .appimage"), "", ""},
		{"document", "\u6587\u6863", strings.Fields(".pdf .txt .md .rtf .doc .docx .xls .xlsx .csv .ppt .pptx .odt .ods .odp .epub .mobi .azw .azw3 .json .xml .html .htm"), "", ""},
		{"project", "\u5de5\u7a0b", append([]string(nil), defaultExcludedExtensions...), "", ""},
		{"other", "\u5176\u4ed6", []string{}, "", ""},
	}}
	for index := range state.Groups {
		state.Groups[index].Directory = defaultGroupDirectory(state.Groups[index])
	}
	return state
}

func normalizeFileGroups(groups []FileGroup) ([]FileGroup, error) {
	invalid := func(message string) ([]FileGroup, error) { return nil, &ValidationError{Message: message} }
	if len(groups) < 1 || len(groups) > 32 {
		return invalid("use 1 to 32 file groups")
	}
	result := make([]FileGroup, 0, len(groups))
	ids, names, suffixes := map[string]bool{}, map[string]bool{}, map[string]string{}
	for _, group := range groups {
		group.Name = strings.TrimSpace(group.Name)
		if !validGroupIcon(group.Icon) {
			return invalid("choose a bundled file group icon")
		}
		if !groupIDPattern.MatchString(group.ID) || group.ID == "all" || ids[group.ID] {
			return invalid("group IDs must be unique and valid")
		}
		if group.Name == "" || utf8.RuneCountInString(group.Name) > 40 || strings.IndexFunc(group.Name, unicode.IsControl) >= 0 || names[strings.ToLower(group.Name)] {
			return invalid("group names must be unique and contain 1 to 40 characters")
		}
		if len(group.Extensions) > 128 || group.ID == "other" && len(group.Extensions) != 0 {
			return invalid("each group accepts up to 128 suffixes; Other must have none")
		}
		ids[group.ID], names[strings.ToLower(group.Name)] = true, true
		directory := strings.TrimSpace(group.Directory)
		if directory == "" {
			directory = defaultGroupDirectory(group)
		}
		if !validGroupDirectory(directory) {
			return invalid("group directory must be a single safe folder name with at most 80 characters")
		}
		normalized := FileGroup{ID: group.ID, Name: group.Name, Extensions: []string{}, Icon: group.Icon, Directory: directory}
		for _, raw := range group.Extensions {
			suffix := strings.ToLower(strings.TrimSpace(raw))
			if !strings.HasPrefix(suffix, ".") {
				suffix = "." + suffix
			}
			if !groupSuffixPattern.MatchString(suffix) {
				return invalid(fmt.Sprintf("invalid suffix %q", raw))
			}
			if previous, exists := suffixes[suffix]; exists {
				if previous == group.ID {
					continue
				}
				return invalid(fmt.Sprintf("suffix %s belongs to more than one group", suffix))
			}
			suffixes[suffix] = group.ID
			normalized.Extensions = append(normalized.Extensions, suffix)
		}
		result = append(result, normalized)
	}
	if !ids["other"] {
		return invalid("the Other fallback group is required")
	}
	return result, nil
}

func readFileGroups(path string) (FileGroupsSnapshot, error) {
	state := defaultFileGroups()
	var saved FileGroupsSnapshot
	err := readStrictJSONFile(path, maxFileGroupsBytes, &saved)
	if os.IsNotExist(err) {
		return state, nil
	}
	if err != nil {
		return state, fmt.Errorf("read file groups: %w", err)
	}
	saved.Groups, err = normalizeFileGroups(saved.Groups)
	return saved, err
}

func cloneFileGroups(state FileGroupsSnapshot) FileGroupsSnapshot {
	result := FileGroupsSnapshot{Revision: state.Revision, Groups: make([]FileGroup, 0, len(state.Groups)), Icons: append([]FileGroupIcon(nil), fileGroupIcons...)}
	for _, group := range state.Groups {
		group.Extensions = append([]string{}, group.Extensions...)
		result.Groups = append(result.Groups, group)
	}
	return result
}

func (m *Manager) fileGroupsLocked() FileGroupsSnapshot {
	if m.fileGroups.Groups == nil {
		return cloneFileGroups(defaultFileGroups())
	}
	return cloneFileGroups(m.fileGroups)
}

func (m *Manager) FileGroups() FileGroupsSnapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.fileGroupsLocked()
}

func (m *Manager) SetFileGroups(revision uint64, groups []FileGroup) (FileGroupsSnapshot, error) {
	normalized, err := normalizeFileGroups(groups)
	if err != nil {
		return FileGroupsSnapshot{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if revision != m.fileGroups.Revision {
		return FileGroupsSnapshot{}, ErrFileGroupsConflict
	}
	next := FileGroupsSnapshot{Revision: revision + 1, Groups: normalized}
	data, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return FileGroupsSnapshot{}, err
	}
	if len(data) >= maxFileGroupsBytes {
		return FileGroupsSnapshot{}, &ValidationError{Message: "file group configuration is too large"}
	}
	if err := writeConfigFile(m.fileGroupsPath, append(data, '\n')); err != nil {
		return FileGroupsSnapshot{}, err
	}
	m.fileGroups = next
	m.fileGroupIndex = indexFileGroups(next.Groups)
	m.revision++
	m.structureRev++
	return cloneFileGroups(next), nil
}
