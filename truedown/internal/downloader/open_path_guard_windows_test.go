//go:build windows

package downloader

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestPathOpenRejectsProgramsAndSpecialPaths(t *testing.T) {
	for _, path := range []string{`C:\file.exe`, `C:\file.cmd`, `C:\file.ps1`, `C:\file.lnk`, `C:\file.url`, `C:\file.hta`, `C:\file.js`, `C:\file.com`, `C:\file.msi`, `C:\file.pdf.exe`, `C:\file.unknown`} {
		if dataFileExtension(path) {
			t.Fatalf("unsafe format accepted: %s", path)
		}
	}
	for _, path := range []string{`\\server\share\file.txt`, `\\?\C:\file.txt`, `C:\file.txt:payload`, `C:\file.txt.`, `C:\folder.{123}\file.txt`, `C:\..\file.txt`, `C:relative.txt`, "https://example.test/file.txt", "C:\\file\x00.txt"} {
		if release, err := lockPathOpenTarget(path); err == nil {
			release()
			t.Fatalf("special path accepted: %q", path)
		}
	}
	root := t.TempDir()
	for _, file := range []struct{ name, content string }{{"run.exe", "MZ"}, {"run.lnk", "shortcut"}, {"disguised.pdf", "MZ payload"}, {"script.txt", "#!/bin/sh"}, {"binary.png", "\x7fELF"}} {
		path := filepath.Join(root, file.name)
		if err := os.WriteFile(path, []byte(file.content), 0600); err != nil {
			t.Fatal(err)
		}
		if release, err := lockPathOpenTarget(path); err == nil {
			release()
			t.Fatalf("executable target accepted: %s", path)
		}
		if err := systemOpenPath(path); err == nil || !strings.Contains(err.Error(), "cannot be launched") {
			t.Fatalf("private helper did not reject unsafe file: %v", err)
		}
	}
}

func TestPathOpenPinsRegularDataAndParents(t *testing.T) {
	root := t.TempDir()
	folder := filepath.Join(root, "data")
	if err := os.Mkdir(folder, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(folder, "notes.txt")
	if err := os.WriteFile(path, []byte("ordinary data"), 0600); err != nil {
		t.Fatal(err)
	}
	release, err := lockPathOpenTarget(path)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if file, err := os.OpenFile(path, os.O_WRONLY, 0600); err == nil {
		file.Close()
		t.Fatal("target remained writable during shell dispatch")
	}
	if err := os.Rename(folder, filepath.Join(root, "moved")); err == nil {
		t.Fatal("parent could be replaced during shell dispatch")
	}
}

func TestPathOpenRejectsReparseParents(t *testing.T) {
	root := t.TempDir()
	destination := filepath.Join(root, "real")
	if err := os.Mkdir(destination, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(destination, "notes.txt"), []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	err := windows.CreateSymbolicLink(windows.StringToUTF16Ptr(link), windows.StringToUTF16Ptr(destination), windows.SYMBOLIC_LINK_FLAG_DIRECTORY|0x2)
	if err != nil {
		t.Skipf("symbolic links unavailable: %v", err)
	}
	if release, err := lockPathOpenTarget(filepath.Join(link, "notes.txt")); err == nil {
		release()
		t.Fatal("reparse parent was accepted")
	}
}
