package downloader

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestFileGroupsPersistAndReclassifyWholePages(t *testing.T) {
	root := t.TempDir()
	m, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	for i := 0; i < 230; i++ {
		name := fmt.Sprintf("image-%03d.PNG", i)
		if i%2 == 0 {
			name = fmt.Sprintf("project-%03d.PSD", i)
		}
		if _, _, err := m.AddTask("https://example.test/"+name, name, "", nil, "", 0, Aria2Opts{}); err != nil {
			t.Fatal(err)
		}
	}
	page, _ := m.PageTaskSnapshotsFilteredIfChanged(100, 100, "", "", "file", "asc", "project", "")
	if page.Total != 115 || len(page.Tasks) != 15 || page.Tasks[0].Name != "project-200.PSD" {
		t.Fatalf("wrong global category page: %+v", page)
	}
	if _, hit := m.PageTaskSnapshotsFilteredIfChanged(100, 100, "", "", "file", "asc", "project", page.Version); !hit {
		t.Fatal("category validator missed")
	}
	groups := m.FileGroups()
	for _, group := range groups.Groups {
		if group.ID == "project" && !reflect.DeepEqual(group.Extensions, defaultExcludedExtensions) {
			t.Fatal("engineering group diverged from Dropbox defaults")
		}
	}
	groups.Groups[6].Extensions = []string{"BLEND"}
	groups.Groups[6].Icon = "palette"
	groups.Groups = append(groups.Groups, FileGroup{"art-source", "Art source", []string{"PSD", ".psd", "tar.gz"}, "", ""})
	saved, err := m.SetFileGroups(groups.Revision, groups.Groups)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Revision != 1 || !reflect.DeepEqual(saved.Groups[8].Extensions, []string{".psd", ".tar.gz"}) {
		t.Fatal(saved)
	}
	if _, hit := m.PageTaskSnapshotsFilteredIfChanged(100, 100, "", "", "file", "asc", "project", page.Version); hit {
		t.Fatal("group mutation reused old validator")
	}
	page, _ = m.PageTaskSnapshotsFilteredIfChanged(0, 100, "", "PROJECT-22", "file", "desc", "art-source", "")
	if page.Total != 5 || page.Tasks[0].Name != "project-228.PSD" {
		t.Fatal(page)
	}
	if m.classifyTask(&Task{Name: "collection.TAR.GZ"}) != "art-source" {
		t.Fatal("longest suffix lost")
	}
	if m.classifyTask(&Task{Name: "wrong.zip", OutputName: "final.PSD"}) != "art-source" {
		t.Fatal("observed name lost")
	}
	if m.classifyTask(&Task{Link: "https://example.test/%61rt.PSD?name=video.mp4"}) != "art-source" {
		t.Fatal("URL path fallback lost")
	}
	if m.classifyTask(&Task{Name: "no-suffix"}) != "other" {
		t.Fatal("missing fallback")
	}
	reloaded, err := readFileGroups(m.fileGroupsPath)
	if err != nil || reloaded.Revision != saved.Revision || !reflect.DeepEqual(reloaded.Groups, saved.Groups) {
		t.Fatal(reloaded, err)
	}
	if reloaded.Groups[6].Icon != "palette" || len(saved.Icons) < 20 {
		t.Fatal("custom icon or catalog was lost")
	}
	invalidGroups := append([]FileGroup(nil), saved.Groups...)
	invalidGroups[0].Icon = "<script>"
	if _, err := m.SetFileGroups(saved.Revision, invalidGroups); err == nil {
		t.Fatal("unknown icon accepted")
	}
	if _, err := m.SetFileGroups(0, groups.Groups); !errors.Is(err, ErrFileGroupsConflict) {
		t.Fatal(err)
	}
	saved.Groups[8].Extensions[0] = ".mutated"
	if m.classifyTask(&Task{Name: "final.psd"}) != "art-source" {
		t.Fatal("returned slice mutated manager")
	}
	blocker := filepath.Join(root, "blocked")
	if err := os.Mkdir(blocker, 0700); err != nil {
		t.Fatal(err)
	}
	m.fileGroupsPath = blocker
	if _, err := m.SetFileGroups(1, groups.Groups); err == nil {
		t.Fatal("failed persistence accepted")
	}
	if m.FileGroups().Revision != 1 {
		t.Fatal("failed settings became visible")
	}
}

func TestFileGroupsRejectAmbiguityAndBoundedPayloads(t *testing.T) {
	for _, groups := range [][]FileGroup{
		{}, {{"image", "Image", []string{".png"}, "", ""}},
		{{"other", "Other", []string{".bin"}, "", ""}},
		{{"other", "Other", nil, "", ""}, {"image", "Image", []string{".png"}, "", ""}, {"custom", "Custom", []string{"PNG"}, "", ""}},
		{{"other", "Other", nil, "", ""}, {"custom", "Other", nil, "", ""}},
		{{"other", "Other", nil, "", ""}, {"custom", "Custom", []string{"../file"}, "", ""}},
		{{"other", "Other", nil, "", ""}, {"../escape", "Custom", nil, "", ""}},
	} {
		if _, err := normalizeFileGroups(groups); err == nil {
			t.Fatalf("invalid groups accepted: %+v", groups)
		}
	}
	groups := defaultFileGroups().Groups
	groups[0].Extensions = make([]string, 129)
	if _, err := normalizeFileGroups(groups); err == nil {
		t.Fatal("unbounded suffixes accepted")
	}
	data, _ := json.Marshal(defaultFileGroups())
	if strings.Contains(string(data), "token") {
		t.Fatal("group settings included credentials")
	}
}
