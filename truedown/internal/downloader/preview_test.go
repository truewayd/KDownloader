package downloader

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func TestPreviewChunksAreBoundedAndRejectChangedFiles(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	manager, err := NewManager("unused", root, filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Stop()
	task, _, err := manager.AddTask("https://example.test/image.png", "image.png", "", nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.PreviewTask(task.ID, 0, ""); !IsValidationError(err) {
		t.Fatalf("unfinished preview: %v", err)
	}
	os.MkdirAll(task.Folder, 0755)
	path := filepath.Join(task.Folder, task.OutputName)
	var encoded bytes.Buffer
	encoder := png.Encoder{CompressionLevel: png.NoCompression}
	if err := encoder.Encode(&encoded, image.NewNRGBA(image.Rect(0, 0, 256, 512))); err != nil {
		t.Fatal(err)
	}
	data := encoded.Bytes()
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	manager.mu.Lock()
	manager.setStatusLocked(manager.tasks[task.ID], StatusDone)
	manager.mu.Unlock()
	first, err := manager.PreviewTask(task.ID, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	decoded, _ := base64.StdEncoding.DecodeString(first.Data)
	if len(decoded) != PreviewChunkSize || first.Size != int64(len(data)) || first.MIME != "image/png" {
		t.Fatalf("invalid first chunk: size=%d bytes=%d", first.Size, len(decoded))
	}
	if first.SHA256 != fmt.Sprintf("%x", sha256.Sum256(data)) {
		t.Fatal("incorrect preview digest")
	}
	last, err := manager.PreviewTask(task.ID, PreviewChunkSize, first.Version)
	if err != nil {
		t.Fatal(err)
	}
	decoded, _ = base64.StdEncoding.DecodeString(last.Data)
	if len(decoded) != len(data)-PreviewChunkSize {
		t.Fatalf("invalid final chunk: %d", len(decoded))
	}
	for _, offset := range []int64{-1, 1, MaxPreviewSize, PreviewChunkSize * 2} {
		if _, err := manager.PreviewTask(task.ID, offset, first.Version); !IsValidationError(err) {
			t.Fatalf("range %d: %v", offset, err)
		}
	}
	if _, err := manager.PreviewTask(task.ID, PreviewChunkSize, ""); !IsValidationError(err) {
		t.Fatalf("missing version: %v", err)
	}
	if err := os.WriteFile(path, []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.PreviewTask(task.ID, 0, first.Version); !IsValidationError(err) {
		t.Fatalf("changed file: %v", err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.PreviewTask(task.ID, 0, ""); !IsValidationError(err) {
		t.Fatalf("missing file: %v", err)
	}
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	err = file.Truncate(MaxPreviewSize + 1)
	file.Close()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.PreviewTask(task.ID, 0, ""); !IsValidationError(err) {
		t.Fatalf("oversize file: %v", err)
	}
}

func TestPreviewRejectsActiveFormatsAndLinkedPaths(t *testing.T) {
	for _, name := range []string{"a.html", "a.svg", "a.exe", "a.pdf", "a.js", "a.url"} {
		if previewMIME(name) != "" {
			t.Fatalf("active format accepted: %s", name)
		}
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "target.txt")
	if err := os.WriteFile(target, []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	hard := filepath.Join(root, "hard.txt")
	if err := os.Link(target, hard); err != nil {
		t.Fatal(err)
	}
	if file, release, err := openPreviewFile(hard); err == nil {
		file.Close()
		release()
		t.Fatal("hard link accepted")
	}
	linked := filepath.Join(root, "linked.txt")
	if err := os.Symlink(target, linked); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	file, release, err := openPreviewFile(linked)
	if err == nil {
		file.Close()
		release()
		t.Fatal("symlink accepted")
	}
}
