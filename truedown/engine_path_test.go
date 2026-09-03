package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveStableAria2HonorsExplicitPath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "custom-aria2")
	if err := os.WriteFile(path, []byte("test"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv(aria2PathEnv, path)
	resolved, err := resolveStableAria2(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	expected, _ := filepath.Abs(path)
	if resolved != expected {
		t.Fatalf("resolved aria2=%q, want %q", resolved, expected)
	}
}

func TestResolveStableAria2RejectsDirectoryOverride(t *testing.T) {
	t.Setenv(aria2PathEnv, t.TempDir())
	if _, err := resolveStableAria2(t.TempDir()); err == nil {
		t.Fatal("directory was accepted as the aria2 executable")
	}
}
