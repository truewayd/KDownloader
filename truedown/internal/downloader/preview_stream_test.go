package downloader

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestPreviewStreamSupportsLargeRangeReadsWithoutWholeFileHash(t *testing.T) {
	root := t.TempDir()
	m, err := NewManager("unused", root, filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	task, _, err := m.AddTask("https://example.test/large.mp4", "large.mp4", "", nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(task.Folder, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(task.Folder, task.OutputName)
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	// ISO-BMFF/MP4 signature followed by a sparse payload larger than 64 MiB.
	header := []byte{0, 0, 0, 0x18, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm', 0, 0, 2, 0, 'i', 's', 'o', 'm', 'm', 'p', '4', '1'}
	if _, err := f.Write(header); err != nil {
		t.Fatal(err)
	}
	const size = 80 * 1024 * 1024
	if err := f.Truncate(size); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	m.setStatusLocked(m.tasks[task.ID], StatusDone)
	m.mu.Unlock()
	file, release, info, mime, err := m.OpenPreviewStream(task.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	defer file.Close()
	if info.Size() != size || mime != "video/mp4" {
		t.Fatalf("size=%d mime=%s", info.Size(), mime)
	}
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/tasks/preview/stream?id=1", nil)
	request.Header.Set("Range", "bytes=70000000-70000127")
	http.ServeContent(response, request, info.Name(), info.ModTime(), file)
	if response.Code != http.StatusPartialContent {
		t.Fatalf("status=%d", response.Code)
	}
	if got := response.Header().Get("Content-Range"); got != "bytes 70000000-70000127/83886080" {
		t.Fatalf("range=%q", got)
	}
	if response.Body.Len() != 128 {
		t.Fatalf("body=%d", response.Body.Len())
	}
	invalid := httptest.NewRecorder()
	badRange := httptest.NewRequest(http.MethodGet, "/tasks/preview/stream?id=1", nil)
	badRange.Header.Set("Range", "bytes=999999999-")
	http.ServeContent(invalid, badRange, info.Name(), info.ModTime(), file)
	if invalid.Code != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("invalid range status=%d", invalid.Code)
	}
}

func TestPreviewStreamRejectsChangedVersionAndNonMedia(t *testing.T) {
	root := t.TempDir()
	m, err := NewManager("unused", root, filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	task, _, err := m.AddTask("https://example.test/file.txt", "file.txt", "", nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(task.Folder, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(task.Folder, task.OutputName), bytes.Repeat([]byte("x"), 32), 0600); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	m.setStatusLocked(m.tasks[task.ID], StatusDone)
	m.mu.Unlock()
	if _, _, _, _, err := m.OpenPreviewStream(task.ID, ""); err == nil {
		t.Fatal("text file streamed")
	}
	mediaTask, _, err := m.AddTask("https://example.test/file.mp4", "file.mp4", "", nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(mediaTask.Folder, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mediaTask.Folder, mediaTask.OutputName), []byte("not an mp4"), 0600); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	m.setStatusLocked(m.tasks[mediaTask.ID], StatusDone)
	m.mu.Unlock()
	if _, _, _, _, err := m.OpenPreviewStream(mediaTask.ID, "wrong-version"); err == nil {
		t.Fatal("stale stream version accepted")
	}
}
