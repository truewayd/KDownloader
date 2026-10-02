package downloader

import (
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"path/filepath"
	"strings"
)

const PreviewChunkSize = 512 * 1024
const MaxPreviewSize = 64 * 1024 * 1024

var previewReadSlots = make(chan struct{}, 2)

type PreviewChunk struct {
	Name    string `json:"name"`
	MIME    string `json:"mime"`
	Size    int64  `json:"size"`
	Version string `json:"version"`
	Offset  int64  `json:"offset"`
	Data    string `json:"data"`
	SHA256  string `json:"sha256,omitempty"`
}

func previewMIME(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".bmp":
		return "image/bmp"
	case ".mp4", ".m4v":
		return "video/mp4"
	case ".webm":
		return "video/webm"
	case ".mp3":
		return "audio/mpeg"
	case ".wav":
		return "audio/wav"
	case ".ogg", ".opus":
		return "audio/ogg"
	case ".flac":
		return "audio/flac"
	case ".m4a":
		return "audio/mp4"
	case ".txt", ".log", ".csv", ".json", ".xml", ".md":
		return "text/plain"
	}
	return ""
}

// Only manager-owned completed output can be read. Never accept a file path.
func (m *Manager) PreviewTask(id, offset int64, version string) (PreviewChunk, error) {
	var result PreviewChunk
	select {
	case previewReadSlots <- struct{}{}:
		defer func() { <-previewReadSlots }()
	default:
		return result, &ValidationError{Message: "Another preview is being read; try again shortly"}
	}
	task, ok := m.GetTask(id)
	if !ok || task.Status != StatusDone || task.OutputName == "" {
		return result, &ValidationError{Message: "Download must be completed before previewing"}
	}
	name := task.OutputName
	if !filepath.IsLocal(name) || filepath.Base(name) != name || strings.ContainsAny(name, "/\\:\x00") || name == "." || name == ".." {
		return result, &ValidationError{Message: "Invalid task output name"}
	}
	mime := previewMIME(name)
	if mime == "" {
		return result, &ValidationError{Message: "This file type cannot be previewed; use Open or Open with"}
	}
	if offset < 0 || offset%PreviewChunkSize != 0 || offset >= MaxPreviewSize || len(version) > 64 || (offset > 0 && len(version) != 64) {
		return result, &ValidationError{Message: "Invalid preview range"}
	}
	path, err := filepath.Abs(filepath.Join(task.Folder, name))
	if err != nil {
		return result, err
	}
	file, release, err := openPreviewFile(path)
	if err != nil {
		return result, &ValidationError{Message: "Downloaded file is unavailable or is a linked path"}
	}
	defer release()
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return result, &ValidationError{Message: "Preview requires a regular file"}
	}
	limit := int64(MaxPreviewSize)
	if mime == "text/plain" {
		limit = 2 * 1024 * 1024
	}
	if info.Size() > limit {
		return result, &ValidationError{Message: fmt.Sprintf("Preview supports files up to %d MiB; use Open or Open with", limit/(1024*1024))}
	}
	if offset > info.Size() {
		return result, &ValidationError{Message: "Preview range exceeds the file"}
	}
	stamp := fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d\x00%d", path, info.Size(), info.ModTime().UnixNano()))))
	if version != "" && stamp != version {
		return result, &ValidationError{Message: "File changed during preview; reopen the preview"}
	}
	digest := ""
	if offset == 0 {
		if err := validatePreviewMedia(file, info.Size(), mime); err != nil {
			return result, &ValidationError{Message: err.Error()}
		}
		hash := sha256.New()
		count, err := io.Copy(hash, io.NewSectionReader(file, 0, info.Size()))
		if err != nil || count != info.Size() {
			return result, &ValidationError{Message: "File changed during preview"}
		}
		digest = fmt.Sprintf("%x", hash.Sum(nil))
	}
	data := make([]byte, min(int64(PreviewChunkSize), info.Size()-offset))
	if len(data) > 0 {
		if _, err := file.ReadAt(data, offset); err != nil && err != io.EOF {
			return result, err
		}
	}
	after, err := file.Stat()
	if err != nil || after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) {
		return result, &ValidationError{Message: "File changed during preview"}
	}
	current, ok := m.GetTask(id)
	if !ok || current.Status != StatusDone || current.Folder != task.Folder || current.OutputName != name {
		return result, &ValidationError{Message: "Task changed during preview"}
	}
	return PreviewChunk{Name: name, MIME: mime, Size: info.Size(), Version: stamp, Offset: offset, Data: base64.StdEncoding.EncodeToString(data), SHA256: digest}, nil
}
