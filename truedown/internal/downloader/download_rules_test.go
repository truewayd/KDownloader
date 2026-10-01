package downloader

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
	"truedown/internal/profile"
)

func TestDownloadRulesMigratesMissingDropboxModeToDirect(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(root, "truedown.download-rules.json"),
		[]byte(`{"enabled":true,"excludedExtensions":[".psd"]}`),
		0600,
	); err != nil {
		t.Fatal(err)
	}
	manager, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Stop()
	rules := manager.DownloadRules()
	if rules.DropboxMode != DropboxModeDirect || rules.FilterMode != DropboxFilterCustom || !rules.Enabled || len(rules.ExcludedExtensions) != 1 {
		t.Fatalf("legacy download rules were not migrated safely: %+v", rules)
	}
}

func TestDropboxFilterModesFollowProjectAndPersistCustom(t *testing.T) {
	root := t.TempDir()
	m, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	if rules := m.DownloadRules(); rules.FilterMode != DropboxFilterProject || !rules.Enabled {
		t.Fatalf("new profiles must follow project: %+v", rules)
	}
	setProject := func(suffixes []string, remove bool) {
		t.Helper()
		state := m.FileGroups()
		for i, group := range state.Groups {
			if group.ID == "project" {
				state.Groups[i].Name = "Renamed project"
				state.Groups[i].Extensions = suffixes
				if remove {
					state.Groups = append(state.Groups[:i], state.Groups[i+1:]...)
				}
				break
			}
		}
		if _, err := m.SetFileGroups(state.Revision, state.Groups); err != nil {
			t.Fatal(err)
		}
	}
	assertFilter := func(want []string) {
		t.Helper()
		rules := m.dropboxFilterRules()
		excluded, err := normalizeDropboxExcludedExtensions(rules, rules.Enabled)
		if err != nil {
			t.Fatal(err)
		}
		if len(excluded) != len(want) {
			t.Fatalf("filter=%v, want=%v", excluded, want)
		}
		for _, suffix := range want {
			if !dropboxFileExcluded("source"+suffix, "", excluded) {
				t.Fatalf("suffix %s not filtered", suffix)
			}
		}
	}
	setProject([]string{".custom.project", ".psd"}, false)
	assertFilter([]string{".custom.project", ".psd"})
	setProject([]string{".kra"}, false)
	assertFilter([]string{".kra"})
	custom := DropboxFilterCustom
	if _, err := m.UpdateDownloadRules(DownloadRulesUpdate{FilterMode: &custom, ExcludedExtensions: []string{".PSD", ".tar.gz", ".psd"}}); err != nil {
		t.Fatal(err)
	}
	setProject([]string{".blend"}, false)
	assertFilter([]string{".psd", ".tar.gz"})
	reloaded, err := newDownloadRulesStoreAt(m.downloadRules.path)
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.snapshot(); got.FilterMode != custom || !slices.Equal(got.ExcludedExtensions, []string{".psd", ".tar.gz"}) {
		t.Fatalf("custom filter did not persist: %+v", got)
	}
	off := DropboxFilterOff
	if _, err := m.UpdateDownloadRules(DownloadRulesUpdate{Enabled: true, FilterMode: &off, ExcludedExtensions: []string{".psd"}}); err != nil {
		t.Fatal(err)
	}
	assertFilter(nil)
	project := DropboxFilterProject
	if _, err := m.UpdateDownloadRules(DownloadRulesUpdate{FilterMode: &project}); err != nil {
		t.Fatal(err)
	}
	assertFilter([]string{".blend"})
	setProject(nil, true)
	assertFilter(nil)
	if got := m.DownloadRules(); got.FilterMode != DropboxFilterOff || got.Enabled {
		t.Fatalf("deleted project did not turn filtering off: %+v", got)
	}
	reloaded, err = newDownloadRulesStoreAt(m.downloadRules.path)
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.snapshot(); got.FilterMode != DropboxFilterOff || got.Enabled {
		t.Fatalf("automatic fallback did not persist: %+v", got)
	}
	if got, err := m.UpdateDownloadRules(DownloadRulesUpdate{FilterMode: &project}); err != nil || got.FilterMode != DropboxFilterOff {
		t.Fatalf("missing project accepted through API: %+v, %v", got, err)
	}
	state := m.FileGroups()
	state.Groups = append(state.Groups, FileGroup{ID: "project", Name: "Project", Extensions: []string{".blend"}})
	if _, err := m.SetFileGroups(state.Revision, state.Groups); err != nil {
		t.Fatal(err)
	}
	assertFilter(nil)
}

func TestDropboxMissingProjectMigratesOnStartup(t *testing.T) {
	root := t.TempDir()
	groups, err := encodeFileGroups(FileGroupsSnapshot{Revision: 1, Groups: []FileGroup{{ID: "other", Name: "Other", Extensions: []string{}}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, profile.FileGroups), groups, 0600); err != nil {
		t.Fatal(err)
	}
	rules := `{"filterMode":"project","enabled":true,"dropboxMode":"expand","excludedExtensions":[".custom"]}`
	if err := os.WriteFile(filepath.Join(root, "truedown.download-rules.json"), []byte(rules), 0600); err != nil {
		t.Fatal(err)
	}
	m, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	reloaded, err := newDownloadRulesStoreAt(m.downloadRules.path)
	if err != nil {
		t.Fatal(err)
	}
	got := reloaded.snapshot()
	if got.FilterMode != DropboxFilterOff || got.Enabled || got.DropboxMode != DropboxModeExpand || !slices.Equal(got.ExcludedExtensions, []string{".custom"}) {
		t.Fatalf("startup fallback lost settings: %+v", got)
	}
}

func TestDownloadRulesLegacyDisabledAndInvalidModes(t *testing.T) {
	store, err := newDownloadRulesStoreAt(filepath.Join(t.TempDir(), "rules.json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.updateRequest(DownloadRulesUpdate{ExcludedExtensions: []string{".psd"}}); err != nil {
		t.Fatal(err)
	}
	reloaded, err := newDownloadRulesStoreAt(store.path)
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.snapshot(); got.FilterMode != DropboxFilterOff || got.Enabled {
		t.Fatalf("legacy disabled changed: %+v", got)
	}
	for _, mode := range []string{"", " ", "unknown"} {
		if _, err := store.updateRequest(DownloadRulesUpdate{FilterMode: &mode}); err == nil {
			t.Fatalf("accepted mode %q", mode)
		}
	}
	if got := store.snapshot(); got.FilterMode != DropboxFilterOff {
		t.Fatalf("invalid update changed rules: %+v", got)
	}
}

func TestDownloadRulesRetainsUninitializedAndEmptyCustomAcrossModes(t *testing.T) {
	store, err := newDownloadRulesStoreAt(filepath.Join(t.TempDir(), "rules.json"))
	if err != nil {
		t.Fatal(err)
	}
	off, custom, project := DropboxFilterOff, DropboxFilterCustom, DropboxFilterProject
	if _, err := store.updateRequest(DownloadRulesUpdate{FilterMode: &off}); err != nil {
		t.Fatal(err)
	}
	reloaded, err := newDownloadRulesStoreAt(store.path)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.snapshot().ExcludedExtensions != nil {
		t.Fatal("turning off prematurely initialized custom suffixes")
	}
	if _, err := store.updateRequest(DownloadRulesUpdate{FilterMode: &custom, ExcludedExtensions: []string{}}); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{project, off, custom} {
		if _, err := store.updateRequest(DownloadRulesUpdate{FilterMode: &mode, ExcludedExtensions: store.snapshot().ExcludedExtensions}); err != nil {
			t.Fatal(err)
		}
		reloaded, err = newDownloadRulesStoreAt(store.path)
		if err != nil {
			t.Fatal(err)
		}
		if got := reloaded.snapshot().ExcludedExtensions; got == nil || len(got) != 0 {
			t.Fatalf("explicit empty custom list lost in %s: %v", mode, got)
		}
	}
}

func TestDownloadRulesRejectsNonObjectPersistentJSON(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "truedown.download-rules.json"), []byte("null\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db")); err == nil {
		t.Fatal("non-object download rules were accepted")
	}
}
