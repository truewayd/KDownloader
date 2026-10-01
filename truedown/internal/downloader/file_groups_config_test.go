package downloader

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"truedown/internal/profile"
)

func TestFileGroupsDocumentSeparatesDefinitionsOrderAndRuntimeCatalog(t *testing.T) {
	path := filepath.Join(t.TempDir(), profile.FileGroups)
	state, err := readFileGroups(path)
	if err != nil {
		t.Fatal(err)
	}
	state.Revision = 3
	state.Icons = fileGroupIcons
	state.Groups[0], state.Groups[6] = state.Groups[6], state.Groups[0]
	data, err := encodeFileGroups(state)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	if len(document) != 4 || document["icons"] != nil || document["groups"] != nil {
		t.Fatalf("persisted runtime fields: %s", data)
	}
	var groups map[string]map[string]json.RawMessage
	if err := json.Unmarshal(document["groupsById"], &groups); err != nil {
		t.Fatal(err)
	}
	for id, fields := range groups {
		if len(fields) != 4 || fields["id"] != nil || fields["icon"] == nil || fields["directory"] == nil {
			t.Fatalf("ambiguous or incomplete definition %s: %v", id, fields)
		}
	}
	if err := writeConfigFile(path, data); err != nil {
		t.Fatal(err)
	}
	reloaded, err := readFileGroups(path)
	if err != nil || !reflect.DeepEqual(state.Groups, reloaded.Groups) || reloaded.Revision != 3 {
		t.Fatalf("roundtrip lost ordering or definitions: %+v, %v", reloaded, err)
	}
}

func TestFileGroupsDocumentRejectsInvalidStructureWithoutOverwriting(t *testing.T) {
	data, err := encodeFileGroups(defaultFileGroups())
	if err != nil {
		t.Fatal(err)
	}
	for name, edit := range map[string]func(map[string]any){
		"version":         func(doc map[string]any) { doc["schemaVersion"] = 1 },
		"unsafe revision": func(doc map[string]any) { doc["revision"] = float64(maxFileGroupsRevision + 1) },
		"duplicate order": func(doc map[string]any) { doc["order"].([]any)[1] = "image" },
		"unknown order":   func(doc map[string]any) { doc["order"].([]any)[1] = "unknown" },
		"omitted order":   func(doc map[string]any) { delete(doc, "order") },
		"unlisted group": func(doc map[string]any) {
			doc["groupsById"].(map[string]any)["extra"] = doc["groupsById"].(map[string]any)["image"]
		},
		"missing icon": func(doc map[string]any) { delete(doc["groupsById"].(map[string]any)["image"].(map[string]any), "icon") },
		"missing directory": func(doc map[string]any) {
			delete(doc["groupsById"].(map[string]any)["image"].(map[string]any), "directory")
		},
		"extra identity":  func(doc map[string]any) { doc["groupsById"].(map[string]any)["image"].(map[string]any)["id"] = "video" },
		"runtime catalog": func(doc map[string]any) { doc["icons"] = []any{} },
	} {
		t.Run(name, func(t *testing.T) {
			var doc map[string]any
			if err := json.Unmarshal(data, &doc); err != nil {
				t.Fatal(err)
			}
			edit(doc)
			invalid, _ := json.Marshal(doc)
			path := filepath.Join(t.TempDir(), profile.FileGroups)
			if err := os.WriteFile(path, invalid, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := readFileGroups(path); err == nil {
				t.Fatal("invalid document accepted")
			}
			got, err := os.ReadFile(path)
			if err != nil || string(got) != string(invalid) {
				t.Fatal("invalid document was overwritten")
			}
		})
	}
}

func TestFileGroupsV2StartsFreshWithoutReadingLegacyGroups(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, "truedown.file-groups.json")
	old := []byte(`{"groups":[{"id":"obsolete","name":"Old group"}]}`)
	if err := os.WriteFile(legacy, old, 0600); err != nil {
		t.Fatal(err)
	}
	m, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	if !reflect.DeepEqual(m.FileGroups().Groups, defaultFileGroups().Groups) {
		t.Fatal("legacy groups were imported")
	}
	got, err := os.ReadFile(legacy)
	if err != nil || string(got) != string(old) {
		t.Fatal("legacy file was modified")
	}
	if filepath.Base(m.fileGroupsPath) != profile.FileGroups {
		t.Fatal("wrong configuration file")
	}
	if _, err := readFileGroups(m.fileGroupsPath); err != nil {
		t.Fatal(err)
	}
}

func TestFileGroupsDocumentRejectsDuplicateIdentityKeys(t *testing.T) {
	data, err := encodeFileGroups(defaultFileGroups())
	if err != nil {
		t.Fatal(err)
	}
	duplicate := strings.Replace(string(data), `"groupsById": {`, `"groupsById": {"image":{"name":"Duplicate","icon":"file","directory":"Duplicate","extensions":[]},`, 1)
	path := filepath.Join(t.TempDir(), profile.FileGroups)
	if err := os.WriteFile(path, []byte(duplicate), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readFileGroups(path); err == nil {
		t.Fatal("duplicate definition ID accepted")
	}
}

func TestFileGroupsRevisionCannotOverflowFrontendPrecision(t *testing.T) {
	m := &Manager{fileGroups: defaultFileGroups()}
	m.fileGroups.Revision = maxFileGroupsRevision
	if _, err := m.SetFileGroups(maxFileGroupsRevision, m.fileGroups.Groups); !IsValidationError(err) {
		t.Fatalf("unsafe revision increment accepted: %v", err)
	}
	if m.fileGroups.Revision != maxFileGroupsRevision {
		t.Fatal("failed write changed revision")
	}
}
