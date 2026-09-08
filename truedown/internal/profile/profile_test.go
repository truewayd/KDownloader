package profile

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestExplicitProfilePrecedesEnvironmentWithoutCreatingFiles(t *testing.T) {
	root := canonicalTempDir(t)
	t.Setenv("TRUEDOWN_DATA_DIR", filepath.Join(root, "environment"))
	explicit := filepath.Join(root, "explicit")
	got, err := Resolve(explicit, root)
	if err != nil || got.DataDirectory != explicit || got.Source != "explicit" {
		t.Fatalf("%+v %v", got, err)
	}
	if _, err := os.Stat(explicit); !os.IsNotExist(err) {
		t.Fatal("resolver mutated filesystem")
	}
	got, err = Resolve("", root)
	if err != nil || got.Source != "environment" {
		t.Fatalf("%+v %v", got, err)
	}
}

func TestPlatformAndLegacyProfiles(t *testing.T) {
	root := canonicalTempDir(t)
	t.Setenv("TRUEDOWN_DATA_DIR", "")
	got, err := Resolve("", root)
	if err != nil || got.Source != "platform" || got.DataDirectory == root {
		t.Fatalf("%+v %v", got, err)
	}
	if runtime.GOOS == "windows" {
		if filepath.Base(got.DataDirectory) != "TrueDown" {
			t.Fatal(got)
		}
		if err := os.WriteFile(filepath.Join(root, Database), []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
		got, err = Resolve("", root)
		if err != nil || got.Source != "legacy" || got.DataDirectory != root {
			t.Fatalf("%+v %v", got, err)
		}
	}
	if runtime.GOOS == "linux" {
		t.Setenv("XDG_DATA_HOME", "relative-path")
		dir, err := DefaultDirectory()
		if err != nil || !filepath.IsAbs(dir) || filepath.Base(dir) != "truedown" {
			t.Fatalf("%s %v", dir, err)
		}
	}
}

func TestLegacyProbeRejectsNonRegularProfileEntry(t *testing.T) {
	root := canonicalTempDir(t)
	if err := os.Mkdir(filepath.Join(root, Database), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := hasLegacyProfile(root); err == nil {
		t.Fatal("invalid existing profile silently ignored")
	}
}

func canonicalTempDir(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return root
}
