package profile

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestProfileLayoutMigratesAndArchivesWithoutMovingDownloads(t *testing.T) {
	root := t.TempDir()
	fixtures := map[string]string{Database: "database fixture", Token: "secret fixture", RuntimeSettings: `{"concurrentDownloads":8}`, ApplicationLog: "startup diagnostic", filepath.Join(ResumeState, "bittorrent.session"): "resumable bytes", filepath.Join(ModulePackages, "dropbox.json"): "module bytes", filepath.Join("downloads", "user-file.bin"): "download bytes"}
	for name, data := range fixtures {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	location, err := Resolve(root, root)
	if err != nil || location.LayoutVersion != 0 {
		t.Fatalf("%+v %v", location, err)
	}
	checkpoints := 0
	location, err = Initialize(context.Background(), location, func(path string) error {
		checkpoints++
		if path != filepath.Join(root, Database) {
			t.Fatal(path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if checkpoints != 1 || location.LayoutVersion != 1 {
		t.Fatal(location, checkpoints)
	}
	for name, want := range fixtures {
		var path string
		switch name {
		case filepath.Join("downloads", "user-file.bin"):
			path = filepath.Join(root, name)
		case filepath.Join(ResumeState, "bittorrent.session"):
			path = filepath.Join(location.Paths.File(ResumeState), "bittorrent.session")
		case filepath.Join(ModulePackages, "dropbox.json"):
			path = filepath.Join(location.Paths.File(ModulePackages), "dropbox.json")
		default:
			path = location.Paths.File(name)
		}
		got, err := os.ReadFile(path)
		if err != nil || string(got) != want {
			t.Fatalf("%s: %q %v", path, got, err)
		}
		if name != filepath.Join("downloads", "user-file.bin") {
			backup, err := os.ReadFile(filepath.Join(root, "profile-backup-v0", name))
			if err != nil || string(backup) != want {
				t.Fatalf("backup %s: %q %v", name, backup, err)
			}
		}
	}
	if _, err := os.Stat(filepath.Join(root, Database)); !os.IsNotExist(err) {
		t.Fatal("legacy database remains active")
	}
	again, err := Resolve(root, root)
	if err != nil || again.Paths != location.Paths {
		t.Fatal(again, err)
	}
	if _, err := Initialize(context.Background(), again, func(string) error { t.Fatal("repeated checkpoint"); return nil }); err != nil {
		t.Fatal(err)
	}
}

func TestProfileMigrationFailureRemainsLegacyAndResumes(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, Database)
	if err := os.WriteFile(path, []byte("before"), 0600); err != nil {
		t.Fatal(err)
	}
	location, _ := Resolve(root, root)
	if _, err := Initialize(context.Background(), location, func(string) error { return fmt.Errorf("database busy") }); err == nil {
		t.Fatal("busy database migrated")
	}
	again, err := Resolve(root, root)
	if err != nil || again.LayoutVersion != 0 {
		t.Fatalf("failed migration committed: %+v %v", again, err)
	}
	if err := os.WriteFile(path, []byte("after"), 0600); err != nil {
		t.Fatal(err)
	}
	// Simulate an earlier verified copy from an interrupted attempt, followed
	// by the user resuming the old core before retrying the migration.
	if err := os.WriteFile(filepath.Join(root, "data", Database), []byte("stale copy"), 0600); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(root, "config", Token), []byte("removed secret"), 0600)
	os.MkdirAll(filepath.Join(root, ModulePackages), 0700)
	os.WriteFile(filepath.Join(root, ModulePackages, "current.json"), []byte("current"), 0600)
	os.MkdirAll(filepath.Join(root, "data", ModulePackages), 0700)
	os.WriteFile(filepath.Join(root, "data", ModulePackages, "removed.json"), []byte("stale module"), 0600)
	finished, err := Initialize(context.Background(), again, func(string) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(finished.Paths.File(Database))
	if err != nil || string(data) != "after" {
		t.Fatalf("%q %v", data, err)
	}
	for _, path := range []string{finished.Paths.File(Token), filepath.Join(finished.Paths.File(ModulePackages), "removed.json")} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("removed source resurrected at %s", path)
		}
	}
}

func TestCommittedMigrationFinishesItsPendingArchive(t *testing.T) {
	root := t.TempDir()
	paths, _ := planPaths(root, "explicit")
	os.MkdirAll(paths.Config, 0700)
	os.Mkdir(filepath.Join(root, "profile-backup-v0"), 0700)
	os.WriteFile(filepath.Join(root, Token), []byte("original"), 0600)
	os.WriteFile(paths.File(Token), []byte("original"), 0600)
	state := layoutState{Version: 1, Source: "explicit", Paths: paths, Backup: filepath.Join(root, "profile-backup-v0"), Pending: []string{Token}}
	if err := writeLayout(root, state); err != nil {
		t.Fatal(err)
	}
	location, err := Resolve(root, root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Initialize(context.Background(), location, nil); err != nil {
		t.Fatal(err)
	}
	state, err = readLayout(root)
	if err != nil || len(state.Pending) != 0 {
		t.Fatal(state, err)
	}
	if data, err := os.ReadFile(filepath.Join(state.Backup, Token)); err != nil || string(data) != "original" {
		t.Fatal(string(data), err)
	}
}

func TestReadOnlyLayoutRecoveryAndPortablePathValidation(t *testing.T) {
	root := t.TempDir()
	paths, _ := planPaths(root, "explicit")
	state := layoutState{Version: 1, Source: "explicit", Paths: paths}
	if err := writeLayout(root, state); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(root, LayoutFile), filepath.Join(root, LayoutFile+".bak")); err != nil {
		t.Fatal(err)
	}
	if _, err := Resolve(root, root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, LayoutFile)); !os.IsNotExist(err) {
		t.Fatal("read-only resolution repaired a file")
	}
	state.Paths.Config = t.TempDir()
	if err := writeLayout(root, state); err != nil {
		t.Fatal(err)
	}
	if _, err := Resolve(root, root); err == nil {
		t.Fatal("portable layout escaped its root")
	}
}

func TestProfileMigrationRejectsExistingDestinationsAndUncheckpointedWAL(t *testing.T) {
	for _, kind := range []string{"collision", "wal"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			if err := os.WriteFile(filepath.Join(root, Database), []byte("database"), 0600); err != nil {
				t.Fatal(err)
			}
			if kind == "collision" {
				os.Mkdir(filepath.Join(root, "config"), 0700)
				os.WriteFile(filepath.Join(root, "config", Token), []byte("other profile"), 0600)
			} else {
				os.WriteFile(filepath.Join(root, Database+"-wal"), []byte("uncheckpointed changes"), 0600)
			}
			location, _ := Resolve(root, root)
			if _, err := Initialize(context.Background(), location, func(string) error { return nil }); err == nil {
				t.Fatal("unsafe migration accepted")
			}
			if _, err := os.Stat(filepath.Join(root, LayoutFile)); !os.IsNotExist(err) {
				t.Fatal("layout was committed")
			}
		})
	}
}

func TestFreshProfilePinsItsLayoutAndDoesNotScatterPreferences(t *testing.T) {
	root := t.TempDir()
	location, err := Resolve(root, root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, LayoutFile)); !os.IsNotExist(err) {
		t.Fatal("read-only resolution wrote a layout")
	}
	location, err = Initialize(context.Background(), location, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{AuthSettings, Token, RuntimeSettings, TaskDefaults, DownloadRules, Modules} {
		if filepath.Dir(location.Paths.File(name)) != filepath.Join(root, "config") {
			t.Fatal(name)
		}
	}
	if filepath.Dir(location.Paths.File(ResumeState)) == location.Paths.Cache {
		t.Fatal("resume state is purgeable")
	}
	if _, err := os.Stat(filepath.Join(root, migrationFile)); !os.IsNotExist(err) {
		t.Fatal("completed migration journal remains")
	}
}
