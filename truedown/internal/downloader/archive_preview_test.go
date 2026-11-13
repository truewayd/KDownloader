package downloader

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func archiveTask(t *testing.T, name string, data []byte) (*Manager, int64) {
	t.Helper()
	root := t.TempDir()
	m, err := NewManager("unused", root, filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	task, _, err := m.AddTask("https://example.test/"+name, name, "", nil, "", 0, Aria2Opts{})
	if err != nil {
		m.Stop()
		t.Fatal(err)
	}
	if err := os.MkdirAll(task.Folder, 0700); err != nil {
		m.Stop()
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(task.Folder, name), data, 0600); err != nil {
		m.Stop()
		t.Fatal(err)
	}
	m.mu.Lock()
	m.setStatusLocked(m.tasks[task.ID], StatusDone)
	m.mu.Unlock()
	return m, task.ID
}

func TestArchivePreviewZIPPaginationAndSafety(t *testing.T) {
	var b bytes.Buffer
	zw := zip.NewWriter(&b)
	for _, name := range []string{"docs/readme.txt", "assets/", "assets/a.bin"} {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if name != "assets/" {
			_, _ = w.Write([]byte("content"))
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	m, id := archiveTask(t, "sample.zip", b.Bytes())
	defer m.Stop()
	first, err := m.ArchivePreview(id, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if first.Format != "zip" || len(first.Entries) != 3 || first.Files != 2 || first.Directories != 1 {
		t.Fatalf("unexpected ZIP summary: %+v", first)
	}
	if first.NextCursor != nil {
		t.Fatal("unexpected next cursor")
	}
	if _, err := m.ArchivePreview(id, 1, first.Version); err == nil {
		t.Fatal("unaligned cursor accepted")
	}
}

func TestArchivePreviewTARAndGZIP(t *testing.T) {
	var tarBytes bytes.Buffer
	tw := tar.NewWriter(&tarBytes)
	if err := tw.WriteHeader(&tar.Header{Name: "folder/file.txt", Mode: 0600, Size: 3}); err != nil {
		t.Fatal(err)
	}
	_, _ = tw.Write([]byte("abc"))
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	m, id := archiveTask(t, "sample.tar", tarBytes.Bytes())
	result, err := m.ArchivePreview(id, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if result.Format != "tar" || len(result.Entries) != 1 || result.Entries[0].DeclaredSize != 3 {
		t.Fatalf("unexpected TAR: %+v", result)
	}
	m.Stop()
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	zw.Name = "payload.txt"
	_, _ = zw.Write([]byte("payload"))
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	m, id = archiveTask(t, "sample.gz", gz.Bytes())
	defer m.Stop()
	result, err = m.ArchivePreview(id, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if result.Format != "gzip" || len(result.Entries) != 1 || result.Entries[0].Name != "payload.txt" {
		t.Fatalf("unexpected GZIP: %+v", result)
	}
}

func TestArchivePreviewRejectsTraversalAndOversizedDeclarations(t *testing.T) {
	var b bytes.Buffer
	zw := zip.NewWriter(&b)
	w, err := zw.Create("../escape.txt")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = w.Write([]byte("x"))
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	m, id := archiveTask(t, "unsafe.zip", b.Bytes())
	defer m.Stop()
	if _, err := m.ArchivePreview(id, 0, ""); err == nil {
		t.Fatal("traversal entry accepted")
	}
	if _, _, err := archiveSafeName("a/../../b"); err == nil {
		t.Fatal("unsafe path accepted")
	}
	if _, _, err := archiveSafeName("a/" + strings.Repeat("b/", archivePreviewMaxDepth) + "x"); err == nil {
		t.Fatal("deep path accepted")
	}
}

func TestArchivePagesAndChanges(t *testing.T) {
	var b bytes.Buffer
	zw := zip.NewWriter(&b)
	for i := 0; i < 451; i++ {
		_, err := zw.Create(fmt.Sprintf("dir/file-%03d.txt", i))
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	m, id := archiveTask(t, "pages.zip", b.Bytes())
	defer m.Stop()
	first, err := m.ArchivePreview(id, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	page := first
	for {
		for _, entry := range page.Entries {
			if names[entry.Name] {
				t.Fatal("duplicate page entry")
			}
			names[entry.Name] = true
		}
		if page.NextCursor == nil {
			break
		}
		page, err = m.ArchivePreview(id, *page.NextCursor, first.Version)
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(names) != 451 || len(page.Entries) != 51 {
		t.Fatalf("entries=%d last=%d", len(names), len(page.Entries))
	}
	if _, err = m.ArchivePreview(id, 200, ""); err == nil {
		t.Fatal("missing version accepted")
	}
	task, _ := m.GetTask(id)
	if err = os.WriteFile(filepath.Join(task.Folder, task.OutputName), []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = m.ArchivePreview(id, 200, first.Version); err == nil {
		t.Fatal("changed file accepted")
	}
}

func TestArchiveMaliciousNamesAndDuplicates(t *testing.T) {
	for _, name := range []string{"../escape", "C:/escape", "C:escape", "/root", `\\server\share`, "a/../b", "a\x00b", "./", strings.Repeat("x", 4097)} {
		if _, _, err := archiveSafeName(name); err == nil {
			t.Fatalf("unsafe name accepted %q", name)
		}
	}
	var b bytes.Buffer
	zw := zip.NewWriter(&b)
	zw.Create("dir/./same")
	zw.Create("dir//same")
	zw.Close()
	m, id := archiveTask(t, "duplicate.zip", b.Bytes())
	defer m.Stop()
	if _, err := m.ArchivePreview(id, 0, ""); err == nil {
		t.Fatal("normalized duplicates accepted")
	}
	for _, format := range []string{"zip", "tar", "gzip"} {
		f, err := os.CreateTemp(t.TempDir(), "invalid")
		if err != nil {
			t.Fatal(err)
		}
		f.Write([]byte("malformed"))
		if _, _, err = readArchiveEntries(f, 9, format); err == nil {
			t.Fatalf("malformed %s accepted", format)
		}
		f.Close()
	}
}

func TestArchiveLargeTARSkipsPayload(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "large.tar")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var header bytes.Buffer
	tw := tar.NewWriter(&header)
	const size = int64(1) << 30
	if err = tw.WriteHeader(&tar.Header{Name: "huge.bin", Mode: 0600, Size: size}); err != nil {
		t.Fatal(err)
	}
	f.Write(header.Bytes())
	f.Seek(size, io.SeekCurrent)
	f.Write(make([]byte, 1024))
	info, _ := f.Stat()
	f.Seek(0, io.SeekStart)
	reader := &archiveBudgetReader{file: f, remaining: 4096}
	tr := tar.NewReader(reader)
	if _, err = tr.Next(); err != nil {
		t.Fatal(err)
	}
	if _, err = tr.Next(); err != io.EOF {
		t.Fatal(err)
	}
	if reader.remaining < 2048 {
		t.Fatalf("payload read: remaining=%d", reader.remaining)
	}
	f.Seek(0, io.SeekStart)
	entries, _, err := readArchiveEntries(f, info.Size(), "tar")
	if err != nil || len(entries) != 1 {
		t.Fatalf("large TAR: %v", err)
	}
}

func TestArchiveRejectsDeclaredSizeLinksAndEntryCount(t *testing.T) {
	t.Run("declared-size", func(t *testing.T) {
		var b bytes.Buffer
		zw := zip.NewWriter(&b)
		_, err := zw.CreateRaw(&zip.FileHeader{Name: "bomb", Method: zip.Store, UncompressedSize64: archivePreviewMaxDeclaredBytes + 1})
		if err != nil {
			t.Fatal(err)
		}
		zw.Close()
		m, id := archiveTask(t, "bomb.zip", b.Bytes())
		defer m.Stop()
		if _, err = m.ArchivePreview(id, 0, ""); err == nil {
			t.Fatal("oversized declaration accepted")
		}
	})
	t.Run("symlink", func(t *testing.T) {
		var b bytes.Buffer
		tw := tar.NewWriter(&b)
		tw.WriteHeader(&tar.Header{Name: "linked", Linkname: "/private", Typeflag: tar.TypeSymlink})
		tw.Close()
		m, id := archiveTask(t, "link.tar", b.Bytes())
		defer m.Stop()
		if _, err := m.ArchivePreview(id, 0, ""); err == nil {
			t.Fatal("link accepted")
		}
	})
	t.Run("entry-count", func(t *testing.T) {
		var b bytes.Buffer
		zw := zip.NewWriter(&b)
		for i := 0; i <= archivePreviewMaxEntries; i++ {
			if _, err := zw.Create(fmt.Sprint(i)); err != nil {
				t.Fatal(err)
			}
		}
		if err := zw.Close(); err != nil {
			t.Fatal(err)
		}
		m, id := archiveTask(t, "many.zip", b.Bytes())
		defer m.Stop()
		if _, err := m.ArchivePreview(id, 0, ""); err == nil {
			t.Fatal("entry cap ignored")
		}
	})
}

func TestArchiveEmptyAndLinkedFile(t *testing.T) {
	var b bytes.Buffer
	zw := zip.NewWriter(&b)
	zw.Close()
	m, id := archiveTask(t, "empty.zip", b.Bytes())
	defer m.Stop()
	result, err := m.ArchivePreview(id, 0, "")
	if err != nil || result.Entries == nil || len(result.Entries) != 0 {
		t.Fatalf("empty archive: %+v %v", result, err)
	}
	task, _ := m.GetTask(id)
	path := filepath.Join(task.Folder, task.OutputName)
	if err = os.Link(path, path+".alias"); err != nil {
		t.Fatal(err)
	}
	if _, err = m.ArchivePreview(id, 0, ""); err == nil {
		t.Fatal("hardlinked archive accepted")
	}
}

func TestArchiveLargeZIPReadsOnlyDirectory(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "large.zip")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	const prefix = int64(1) << 30
	if _, err = f.Seek(prefix, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	zw.SetOffset(prefix)
	if _, err = zw.Create("entry.txt"); err != nil {
		t.Fatal(err)
	}
	if err = zw.Close(); err != nil {
		t.Fatal(err)
	}
	info, _ := f.Stat()
	reader := &archiveBudgetReader{file: f, remaining: 128 * 1024}
	z, err := zip.NewReader(reader, info.Size())
	if err != nil || len(z.File) != 1 {
		t.Fatalf("large ZIP directory: %v", err)
	}
	if used := 128*1024 - reader.remaining; used > 100*1024 {
		t.Fatalf("too much I/O: %d", used)
	}
	f.Seek(0, io.SeekStart)
	entries, _, err := readArchiveEntries(f, info.Size(), "zip")
	if err != nil || len(entries) != 1 {
		t.Fatalf("large ZIP: %v", err)
	}
}
