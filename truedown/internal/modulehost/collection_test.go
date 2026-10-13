package modulehost

import (
	"encoding/json"
	"testing"
)

func TestCollectionRejectsUnsafeAndCollidingPaths(t *testing.T) {
	entry := ArtifactEntry{Source: "https://example.test/file", Path: []string{"dir", "file.txt"}, Size: 1, Data: json.RawMessage(`{}`)}
	for _, name := range []string{"..", "a/b", "C:", "NUL.txt", "trailing.", "a\\b", "CON", "LPT1.txt"} {
		copy := entry
		copy.Path = []string{name}
		if _, err := ValidateCollection(&ArtifactCollection{Name: "root", Entries: []ArtifactEntry{copy}}); err == nil {
			t.Fatal("unsafe path accepted", name)
		}
	}
	copy := entry
	copy.Path = []string{"DIR", "FILE.TXT"}
	if _, err := ValidateCollection(&ArtifactCollection{Name: "root", Entries: []ArtifactEntry{entry, copy}}); err == nil {
		t.Fatal("case collision accepted")
	}
	copy.Path = []string{"dir"}
	if _, err := ValidateCollection(&ArtifactCollection{Name: "root", Entries: []ArtifactEntry{entry, copy}}); err == nil {
		t.Fatal("file/directory collision accepted")
	}
	directory := ArtifactEntry{Path: []string{"dir"}, Directory: true}
	if size, err := ValidateCollection(&ArtifactCollection{Name: "root", Entries: []ArtifactEntry{entry, directory}}); err != nil || size != 1 {
		t.Fatal("explicit parent directory rejected", err)
	}
}
