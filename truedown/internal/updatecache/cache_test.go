package updatecache

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRemoveFlatPreservesForeignContentsAndRejectsTraversal(t *testing.T) {
	for _, scenario := range []string{"owned", "foreign", "nested", "symlink"} {
		t.Run(scenario, func(t *testing.T) {
			path, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			child := filepath.Join(path, "stage")
			if err := os.Mkdir(child, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(child, "payload"), []byte("owned"), 0600); err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "foreign":
				if err := os.WriteFile(filepath.Join(child, "user.txt"), nil, 0600); err != nil {
					t.Fatal(err)
				}
			case "nested":
				if err := os.Mkdir(filepath.Join(child, "nested"), 0700); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Symlink(t.TempDir(), filepath.Join(child, "link")); err != nil {
					t.Skip(err)
				}
			}
			root, err := Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer root.Close()
			allowed := func(name string) bool { return name == "payload" }
			if err := RemoveFlat(root, "../escape", allowed); err == nil {
				t.Fatal("traversal accepted")
			}
			err = RemoveFlat(root, "stage", allowed)
			if scenario == "owned" {
				if err != nil {
					t.Fatal(err)
				}
				if _, err := os.Lstat(child); !os.IsNotExist(err) {
					t.Fatal("stage retained", err)
				}
			} else {
				if err == nil {
					t.Fatal("unsafe stage removed")
				}
				if _, err := os.Lstat(filepath.Join(child, "payload")); err != nil {
					t.Fatal("partially removed unsafe stage", err)
				}
			}
		})
	}
}

func TestOpenRefusesDirectoryAliases(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(base, "real", "child"), 0700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(base, "alias")
	if err := os.Symlink(filepath.Join(base, "real"), alias); err != nil {
		t.Skip(err)
	}
	for _, path := range []string{alias, filepath.Join(alias, "child")} {
		if root, err := Open(path); err == nil {
			root.Close()
			t.Fatal("alias accepted", path)
		}
	}
}
