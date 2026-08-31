package downloader

import (
	"os"
	"path/filepath"
	"testing"
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
	if rules.DropboxMode != DropboxModeDirect || !rules.Enabled || len(rules.ExcludedExtensions) != 1 {
		t.Fatalf("legacy download rules were not migrated safely: %+v", rules)
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
