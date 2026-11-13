package downloader

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	ArchivePreviewPageSize         = 200
	archivePreviewMaxBytes         = 256 * 1024 * 1024
	archivePreviewMaxEntries       = 100000
	archivePreviewMaxPathBytes     = 4096
	archivePreviewMaxDepth         = 64
	archivePreviewMaxDeclaredBytes = uint64(1) << 40
)

type ArchiveEntry struct {
	Name         string    `json:"name"`
	Directory    bool      `json:"directory"`
	PackedSize   uint64    `json:"packedSize"`
	DeclaredSize uint64    `json:"declaredSize"`
	Modified     time.Time `json:"modified,omitempty"`
	Method       string    `json:"method,omitempty"`
}

type ArchivePreview struct {
	Name          string         `json:"name"`
	Format        string         `json:"format"`
	Size          int64          `json:"size"`
	Modified      time.Time      `json:"modified"`
	Encrypted     bool           `json:"encrypted"`
	Complete      bool           `json:"complete"`
	Directories   int            `json:"directories"`
	Files         int            `json:"files"`
	DeclaredBytes uint64         `json:"declaredBytes"`
	Cursor        int            `json:"cursor"`
	NextCursor    *int           `json:"nextCursor,omitempty"`
	Entries       []ArchiveEntry `json:"entries"`
	Version       string         `json:"version"`
}

func archiveFormat(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".zip":
		return "zip"
	case ".tar":
		return "tar"
	case ".gz":
		return "gzip"
	}
	return ""
}
func archiveSafeName(name string) (string, int, error) {
	name = strings.ReplaceAll(name, "\\", "/")
	if name == "" || strings.ContainsAny(name, "\x00:") || !utf8.ValidString(name) || len(name) > archivePreviewMaxPathBytes || strings.HasPrefix(name, "/") || filepath.VolumeName(name) != "" {
		return "", 0, fmt.Errorf("archive entry has an unsafe path")
	}
	parts := strings.Split(name, "/")
	clean := make([]string, 0, len(parts))
	depth := 0
	for _, part := range parts {
		if part == "" || part == "." {
			continue
		}
		if part == ".." {
			return "", 0, fmt.Errorf("archive entry has an unsafe path")
		}
		clean = append(clean, part)
		depth++
	}
	if depth > archivePreviewMaxDepth {
		return "", 0, fmt.Errorf("archive entry exceeds the nesting limit")
	}
	if depth == 0 {
		return "", 0, fmt.Errorf("archive entry has an empty path")
	}
	return strings.Join(clean, "/"), depth, nil
}

func (m *Manager) ArchivePreview(id int64, cursor int, version string) (ArchivePreview, error) {
	var out ArchivePreview
	select {
	case previewReadSlots <- struct{}{}:
		defer func() { <-previewReadSlots }()
	default:
		return out, &ValidationError{Message: "Another preview is being read; try again shortly"}
	}
	if cursor < 0 || cursor > archivePreviewMaxEntries || cursor%ArchivePreviewPageSize != 0 || (cursor > 0 && len(version) != 64) || (version != "" && len(version) != 64) {
		return out, &ValidationError{Message: "Invalid archive preview cursor"}
	}
	task, ok := m.GetTask(id)
	if !ok || task.Status != StatusDone || task.OutputName == "" {
		return out, &ValidationError{Message: "Download must be completed before previewing"}
	}
	if !filepath.IsLocal(task.OutputName) || filepath.Base(task.OutputName) != task.OutputName || strings.ContainsAny(task.OutputName, "/\\:\x00") {
		return out, &ValidationError{Message: "Invalid archive output name"}
	}
	format := archiveFormat(task.OutputName)
	if format == "" {
		return out, &ValidationError{Message: "This archive format cannot be previewed"}
	}
	path, err := filepath.Abs(filepath.Join(task.Folder, task.OutputName))
	if err != nil {
		return out, err
	}
	file, release, err := openPreviewFile(path)
	if err != nil {
		return out, &ValidationError{Message: "Downloaded archive is unavailable or is a linked path"}
	}
	defer release()
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return out, &ValidationError{Message: "Archive preview requires a regular file"}
	}
	versionStamp := fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d\x00%d", path, info.Size(), info.ModTime().UnixNano()))))
	if version != "" && version != versionStamp {
		return out, &ValidationError{Message: "Archive changed during preview; reopen the preview"}
	}
	entries, encrypted, err := readArchiveEntries(file, info.Size(), format)
	if err != nil {
		return out, &ValidationError{Message: err.Error()}
	}
	if format == "gzip" && len(entries) == 1 && entries[0].Name == "" {
		entries[0].Name = strings.TrimSuffix(task.OutputName, filepath.Ext(task.OutputName))
	}
	seen := make(map[string]struct{}, len(entries))
	var declared uint64
	dirs, files := 0, 0
	for i := range entries {
		clean, _, err := archiveSafeName(entries[i].Name)
		if err != nil {
			return out, &ValidationError{Message: err.Error()}
		}
		if _, ok := seen[clean]; ok {
			return out, &ValidationError{Message: "Archive contains duplicate entry names"}
		}
		seen[clean] = struct{}{}
		entries[i].Name = clean
		if entries[i].Directory {
			dirs++
		} else {
			files++
		}
		if ^uint64(0)-declared < entries[i].DeclaredSize || declared+entries[i].DeclaredSize > archivePreviewMaxDeclaredBytes {
			return out, &ValidationError{Message: "Archive declared size exceeds the preview limit"}
		}
		declared += entries[i].DeclaredSize
	}
	if cursor > len(entries) {
		return out, &ValidationError{Message: "Archive preview cursor exceeds the entry list"}
	}
	end := cursor + ArchivePreviewPageSize
	if end > len(entries) {
		end = len(entries)
	}
	after, err := file.Stat()
	current, ok := m.GetTask(id)
	if err != nil || after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) || !ok || current.Status != StatusDone || current.Folder != task.Folder || current.OutputName != task.OutputName {
		return out, &ValidationError{Message: "Archive changed during preview; reopen the preview"}
	}
	page := append([]ArchiveEntry{}, entries[cursor:end]...)
	out = ArchivePreview{Name: task.OutputName, Format: format, Size: info.Size(), Modified: info.ModTime(), Encrypted: encrypted, Complete: true, Directories: dirs, Files: files, DeclaredBytes: declared, Cursor: cursor, Entries: page, Version: versionStamp}
	if end < len(entries) {
		out.NextCursor = &end
	}
	return out, nil
}

func readArchiveEntries(file *os.File, size int64, format string) ([]ArchiveEntry, bool, error) {
	reader := &archiveBudgetReader{file: file, remaining: archivePreviewMaxBytes}
	switch format {
	case "zip":
		r, err := zip.NewReader(reader, size)
		if err != nil {
			return nil, false, fmt.Errorf("invalid ZIP archive")
		}
		if len(r.File) > archivePreviewMaxEntries {
			return nil, false, fmt.Errorf("archive contains too many entries")
		}
		out := make([]ArchiveEntry, 0, len(r.File))
		encrypted := false
		for _, f := range r.File {
			if f.Flags&1 != 0 {
				encrypted = true
			}
			if f.Mode()&os.ModeSymlink != 0 {
				return nil, false, fmt.Errorf("archive contains linked entries")
			}
			out = append(out, ArchiveEntry{Name: f.Name, Directory: strings.HasSuffix(f.Name, "/"), PackedSize: f.CompressedSize64, DeclaredSize: f.UncompressedSize64, Modified: f.Modified, Method: strconv.Itoa(int(f.Method))})
		}
		return out, encrypted, nil
	case "tar":
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			return nil, false, err
		}
		tr := tar.NewReader(reader)
		out := []ArchiveEntry{}
		for len(out) <= archivePreviewMaxEntries {
			h, err := tr.Next()
			if err == io.EOF {
				return out, false, nil
			}
			if err != nil {
				return nil, false, fmt.Errorf("invalid TAR archive")
			}
			if h.Size < 0 || uint64(h.Size) > archivePreviewMaxDeclaredBytes {
				return nil, false, fmt.Errorf("archive declared size exceeds the preview limit")
			}
			if h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeRegA && h.Typeflag != tar.TypeDir {
				return nil, false, fmt.Errorf("archive contains unsupported linked or special entries")
			}
			out = append(out, ArchiveEntry{Name: h.Name, Directory: h.FileInfo().IsDir(), DeclaredSize: uint64(h.Size), Modified: h.ModTime, Method: "tar"})
		}
		return nil, false, fmt.Errorf("archive contains too many entries")
	case "gzip":
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			return nil, false, err
		}
		gz, err := gzip.NewReader(reader)
		if err != nil {
			return nil, false, fmt.Errorf("invalid GZIP archive")
		}
		defer gz.Close()
		return []ArchiveEntry{{Name: gz.Name, DeclaredSize: 0, Method: "gzip"}}, false, nil
	}
	return nil, false, fmt.Errorf("unsupported archive format")
}

// Count structural I/O while allowing seeks over member payloads.
type archiveBudgetReader struct {
	file      *os.File
	remaining int64
}

func (r *archiveBudgetReader) Read(p []byte) (int, error) {
	if int64(len(p)) > r.remaining {
		return 0, fmt.Errorf("archive scan budget exceeded")
	}
	n, err := r.file.Read(p)
	r.remaining -= int64(n)
	return n, err
}
func (r *archiveBudgetReader) ReadAt(p []byte, off int64) (int, error) {
	if int64(len(p)) > r.remaining {
		return 0, fmt.Errorf("archive scan budget exceeded")
	}
	n, err := r.file.ReadAt(p, off)
	r.remaining -= int64(n)
	return n, err
}
func (r *archiveBudgetReader) Seek(off int64, whence int) (int64, error) {
	return r.file.Seek(off, whence)
}
