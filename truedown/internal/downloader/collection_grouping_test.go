package downloader

import (
	"path/filepath"
	"testing"
)

func TestCollectionGroupingPinsHierarchyAndRejectsTraversal(t *testing.T) {
	root := t.TempDir()
	m, err := NewManager("unused", root, filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	for _, module := range []string{GoogleDriveModuleID, DropboxModuleID, "mega", MediaFireModuleID} {
		request := taskAddRequest{Link: "https://example.test/" + module + ".png", Name: "photo.png", Folder: root, ModuleID: module, CollectionPath: []string{"Shared", "nested"}}
		added, err := m.addTasksBatch([]taskAddRequest{request})
		if err != nil {
			t.Fatal(err)
		}
		expected := filepath.Join(root, "Pictures", "Shared", "nested")
		if added[0].Task.Folder != expected {
			t.Fatalf("%s: %s", module, added[0].Task.Folder)
		}
		replay, err := m.addTasksBatch([]taskAddRequest{request})
		if err != nil || !replay[0].Duplicate || replay[0].Task.Folder != expected {
			t.Fatalf("replay: %+v %v", replay, err)
		}
	}
	for _, part := range []string{"..", ".", "", "a/b", `a\b`, "C:"} {
		_, err := m.addTasksBatch([]taskAddRequest{{Link: "https://example.test/unsafe.png", Name: "unsafe.png", Folder: root, CollectionPath: []string{part}}})
		if err == nil {
			t.Fatalf("accepted collection component %q", part)
		}
	}
}
