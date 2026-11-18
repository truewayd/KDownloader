package downloader

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestCollectionGroupingPinsHierarchyAndRejectsTraversal(t *testing.T) {
	root := t.TempDir()
	m, err := NewManager("unused", root, filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	for module, directory := range map[string]string{GoogleDriveModuleID: "GoogleDrive", DropboxModuleID: "Dropbox", "mega": "MEGA", MediaFireModuleID: "MediaFire", TelegraphModuleID: "Telegraph"} {
		request := taskAddRequest{Link: "https://example.test/" + module + ".png", Name: "photo.png", Folder: root, ModuleID: module, CollectionPath: []string{"Shared", "nested"}, CollectionSource: "share"}
		added, err := m.addTasksBatch([]taskAddRequest{request})
		if err != nil {
			t.Fatal(err)
		}
		folder := added[0].Task.Folder
		parent := filepath.Dir(folder)
		if filepath.Base(folder) != "nested" || !strings.HasPrefix(filepath.Base(parent), "Shared [") || filepath.Dir(parent) != filepath.Join(root, directory) {
			t.Fatalf("%s: %s", module, folder)
		}
		replay, err := m.addTasksBatch([]taskAddRequest{request})
		if err != nil || !replay[0].Duplicate || replay[0].Task.Folder != folder {
			t.Fatalf("replay: %+v %v", replay, err)
		}
		otherShare := request
		otherShare.CollectionSource = "different share"
		second, err := m.addTasksBatch([]taskAddRequest{otherShare})
		if err != nil || second[0].Duplicate || second[0].Task.Folder == folder {
			t.Fatalf("same-name share was not separated: %+v %v", second, err)
		}
	}
	if err := m.SetCollectionLayout(CollectionLayoutSettings{Layout: CollectionLayoutCategory}); err != nil {
		t.Fatal(err)
	}
	image := taskAddRequest{Link: "https://example.test/photo", Name: "photo.png", Folder: root, ModuleID: GoogleDriveModuleID, CollectionPath: []string{"Shared"}, CollectionSource: "categorized share"}
	video := image
	video.Link, video.Name = "https://example.test/clip", "video.mp4"
	grouped, err := m.addTasksBatch([]taskAddRequest{image, video})
	if err != nil || grouped[0].Task.Folder != filepath.Join(root, "Pictures", "Shared") || grouped[1].Task.Folder != filepath.Join(root, "Videos", "Shared") {
		t.Fatalf("category layout: %+v %v", grouped, err)
	}
	legacy := image
	legacy.Link, legacy.Name, legacy.CollectionSource = "https://example.test/old", "old.png", ""
	old, err := m.addTasksBatch([]taskAddRequest{legacy})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.SetCollectionLayout(CollectionLayoutSettings{Layout: CollectionLayoutModule}); err != nil {
		t.Fatal(err)
	}
	replayed, err := m.addTasksBatch([]taskAddRequest{image, video})
	if err != nil || !replayed[0].Duplicate || !replayed[1].Duplicate || replayed[0].Task.Folder != grouped[0].Task.Folder || replayed[1].Task.Folder != grouped[1].Task.Folder {
		t.Fatalf("layout change moved existing tasks: %+v %v", replayed, err)
	}
	legacy.CollectionSource = "previously expanded share"
	replayed, err = m.addTasksBatch([]taskAddRequest{legacy})
	if err != nil || !replayed[0].Duplicate || replayed[0].Task.ID != old[0].Task.ID || replayed[0].Task.Folder != old[0].Task.Folder {
		t.Fatalf("legacy collection was not reused: %+v %v", replayed, err)
	}
	for _, part := range []string{"..", ".", "", "a/b", `a\b`, "C:"} {
		_, err := m.addTasksBatch([]taskAddRequest{{Link: "https://example.test/unsafe.png", Name: "unsafe.png", Folder: root, CollectionPath: []string{part}}})
		if err == nil {
			t.Fatalf("accepted collection component %q", part)
		}
	}
}
