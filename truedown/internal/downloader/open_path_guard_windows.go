//go:build windows

package downloader

import (
	"fmt"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// Explicit data formats only. Executables, scripts, shortcuts, shell documents
// and unknown types must be opened deliberately from their download directory.
func dataFileExtension(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".txt", ".log", ".csv", ".json", ".xml", ".md", ".pdf",
		".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp",
		".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp", ".tif", ".tiff", ".heic", ".heif",
		".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a", ".opus",
		".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v",
		".zip", ".7z", ".rar", ".tar", ".gz", ".bz2", ".xz":
		return true
	}
	return false
}

func lockPathOpenTarget(path string) (func(), error) {
	volume := filepath.VolumeName(path)
	if len(path) > 32768 || len(volume) != 2 || volume[1] != ':' || !filepath.IsAbs(path) || filepath.Clean(path) != path || strings.ContainsRune(path, 0) {
		return nil, fmt.Errorf("open only an absolute local drive path")
	}
	parts := strings.Split(strings.TrimPrefix(path[len(volume):], `\`), `\`)
	if len(parts) > 256 {
		return nil, fmt.Errorf("path has too many components")
	}
	for _, part := range parts {
		if strings.ContainsAny(part, ":/\x00") || strings.TrimRight(part, " .") != part || strings.Contains(part, ".{") {
			return nil, fmt.Errorf("ambiguous or special shell path is not allowed")
		}
	}
	var handles []windows.Handle
	release := func() {
		for index := len(handles) - 1; index >= 0; index-- {
			windows.CloseHandle(handles[index])
		}
	}
	current := volume + `\`
	paths := []string{current}
	for _, part := range parts {
		if part != "" {
			current = filepath.Join(current, part)
			paths = append(paths, current)
		}
	}
	for index, target := range paths {
		pointer, err := windows.UTF16PtrFromString(target)
		if err != nil {
			release()
			return nil, err
		}
		access, sharing := uint32(windows.FILE_READ_ATTRIBUTES), uint32(windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE)
		if index == len(paths)-1 {
			access = windows.GENERIC_READ
			sharing = windows.FILE_SHARE_READ
		}
		handle, err := windows.CreateFile(pointer, access, sharing, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
		if err != nil {
			release()
			return nil, fmt.Errorf("inspect open target: %w", err)
		}
		handles = append(handles, handle)
		var info windows.ByHandleFileInformation
		if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
			release()
			return nil, err
		}
		if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			release()
			return nil, fmt.Errorf("refuse to open a reparse point")
		}
		directory := info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0
		if index < len(paths)-1 && !directory {
			release()
			return nil, fmt.Errorf("open target has a non-directory parent")
		}
		if index == len(paths)-1 && !directory {
			if !dataFileExtension(path) {
				release()
				return nil, fmt.Errorf("this file type cannot be launched from TrueDown; open its download directory instead")
			}
			kind, err := windows.GetFileType(handle)
			if err != nil || kind != windows.FILE_TYPE_DISK {
				release()
				return nil, fmt.Errorf("open target is not a regular disk file")
			}
			var header [4]byte
			var read uint32
			if err := windows.ReadFile(handle, header[:], &read, nil); err != nil {
				release()
				return nil, err
			}
			if (read >= 2 && (string(header[:2]) == "MZ" || string(header[:2]) == "#!")) || (read == 4 && string(header[:]) == "\x7fELF") {
				release()
				return nil, fmt.Errorf("executable content cannot be launched from TrueDown; open its download directory instead")
			}
		}
	}
	// Deny rename/replacement while Shell resolves every path component.
	return release, nil
}
