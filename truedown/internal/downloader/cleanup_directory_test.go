package downloader

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCleanupRejectsLinkedParentWithoutTouchingPair(t *testing.T) {
	for _, nested := range []bool{false, true} {
		t.Run(map[bool]string{false: "directory", true: "ancestor"}[nested], func(t *testing.T) {
			base := artifactTempDir(t)
			real := filepath.Join(base, "real")
			if err := os.Mkdir(real, 0700); err != nil {
				t.Fatal(err)
			}
			alias := filepath.Join(base, "alias")
			if err := os.Symlink(real, alias); err != nil {
				t.Skipf("directory symlink unavailable: %v", err)
			}
			folder := real
			if nested {
				folder = filepath.Join(real, "nested")
				alias = filepath.Join(alias, "nested")
				if err := os.Mkdir(folder, 0700); err != nil {
					t.Fatal(err)
				}
			}
			for _, suffix := range []string{"", ".aria2"} {
				if err := os.WriteFile(filepath.Join(folder, "file.bin"+suffix), []byte("foreign"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := removePartialFiles(&Task{Folder: alias, OutputName: "file.bin"}, ""); err == nil || !strings.Contains(err.Error(), "contains a link") {
				t.Fatalf("linked parent was not diagnosed: %v", err)
			}
			for _, suffix := range []string{"", ".aria2"} {
				if data, err := os.ReadFile(filepath.Join(folder, "file.bin"+suffix)); err != nil || string(data) != "foreign" {
					t.Fatalf("foreign pair changed: %q %v", data, err)
				}
			}
		})
	}
}

func TestCleanupRejectsDirectoryReplacementBetweenInspectionAndOpen(t *testing.T) {
	base := artifactTempDir(t)
	folder := filepath.Join(base, "downloads")
	if err := os.Mkdir(folder, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "file.bin"), []byte("owned"), 0600); err != nil {
		t.Fatal(err)
	}
	swapped := false
	root, err := openCleanupDirectoryWith(folder, func(parent *os.Root, name string) (*os.Root, error) {
		if name == "downloads" {
			if err := os.Rename(folder, folder+"-old"); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(folder, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(folder, "file.bin"), []byte("foreign"), 0600); err != nil {
				t.Fatal(err)
			}
			swapped = true
		}
		return parent.OpenRoot(name)
	})
	if root != nil {
		root.Close()
	}
	if !swapped || err == nil {
		t.Fatalf("directory replacement accepted: swapped=%v err=%v", swapped, err)
	}
	for _, test := range []struct{ folder, want string }{{folder, "foreign"}, {folder + "-old", "owned"}} {
		if data, err := os.ReadFile(filepath.Join(test.folder, "file.bin")); err != nil || string(data) != test.want {
			t.Fatalf("data changed: %q %v", data, err)
		}
	}
}

func TestCleanupRootDoesNotFollowRenamedParent(t *testing.T) {
	base := artifactTempDir(t)
	folder := filepath.Join(base, "downloads")
	if err := os.Mkdir(folder, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "file.bin"), []byte("owned"), 0600); err != nil {
		t.Fatal(err)
	}
	m, _ := transferTestManager(t)
	task := &Task{ID: 900, Folder: folder, OutputName: "file.bin"}
	err := removePartialFilesChecked(task, "", func(root *os.Root) error {
		m.mu.RLock()
		err := m.checkPhysicalOutputOwnershipLocked(task, root)
		m.mu.RUnlock()
		if err != nil {
			return err
		}
		if err := os.Rename(folder, folder+"-old"); err != nil {
			t.Skipf("OS prevents renaming retained directory: %v", err)
		}
		if err := os.Mkdir(folder, 0700); err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(folder, "file.bin"), []byte("foreign"), 0600)
	})
	if err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(filepath.Join(folder, "file.bin")); err != nil || string(data) != "foreign" {
		t.Fatalf("replacement was changed: %q %v", data, err)
	}
	if _, err := os.Stat(filepath.Join(folder+"-old", "file.bin")); !os.IsNotExist(err) {
		t.Fatal("original partial remains", err)
	}
}
