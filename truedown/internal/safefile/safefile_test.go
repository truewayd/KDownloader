package safefile

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestWriteFileReplacesAndRecoversBoundedConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	if err := WriteFile(path, []byte("old\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := WriteFile(path, []byte("new\n"), 0600); err != nil {
		t.Fatal(err)
	}
	data, err := ReadFile(path, 16)
	if err != nil || string(data) != "new\n" {
		t.Fatalf("replaced data=%q err=%v", data, err)
	}
	if err := os.Rename(path, path+".bak"); err != nil {
		t.Fatal(err)
	}
	data, err = ReadFile(path, 16)
	if err != nil || string(data) != "new\n" {
		t.Fatalf("recovered data=%q err=%v", data, err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("backup was not restored to the primary path: %v", err)
	}
	if _, err := os.Lstat(path + ".bak"); !os.IsNotExist(err) {
		t.Fatalf("backup remained after recovery: %v", err)
	}
	if _, err := ReadFile(path, 2); err == nil {
		t.Fatal("oversized file was accepted")
	}
}

func TestWriteFileRestoresBackupBeforeReplacingIt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(path+".bak", []byte("last-good\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := WriteFile(path, []byte("new\n"), 0600); err != nil {
		t.Fatal(err)
	}
	data, err := ReadFile(path, 32)
	if err != nil || string(data) != "new\n" {
		t.Fatalf("replacement data=%q err=%v", data, err)
	}
}

func TestConcurrentBackupRecoveryAndWriteRemainConsistent(t *testing.T) {
	root := t.TempDir()
	for iteration := 0; iteration < 50; iteration++ {
		path := filepath.Join(root, fmt.Sprintf("settings-%d.json", iteration))
		if err := os.WriteFile(path+".bak", []byte("last-good\n"), 0600); err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		errors := make(chan error, 2)
		var workers sync.WaitGroup
		workers.Add(2)
		go func() {
			defer workers.Done()
			<-start
			_, err := ReadFile(path, 32)
			errors <- err
		}()
		go func() {
			defer workers.Done()
			<-start
			errors <- WriteFile(path, []byte("new\n"), 0600)
		}()
		close(start)
		workers.Wait()
		close(errors)
		for err := range errors {
			if err != nil {
				t.Fatalf("iteration %d: %v", iteration, err)
			}
		}
		data, err := ReadFile(path, 32)
		if err != nil || string(data) != "new\n" {
			t.Fatalf("iteration %d data=%q err=%v", iteration, data, err)
		}
		if _, err := os.Lstat(path + ".bak"); !os.IsNotExist(err) {
			t.Fatalf("iteration %d retained backup: %v", iteration, err)
		}
	}
}

func TestWriteFileRefusesToReplaceDirectory(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "settings.json")
	backupPath := path + ".bak"
	if err := os.WriteFile(backupPath, []byte("last-good\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if err := WriteFile(path, []byte("data"), 0600); err == nil {
		t.Fatal("directory target was replaced")
	}
	backup, err := os.ReadFile(backupPath)
	if err != nil || string(backup) != "last-good\n" {
		t.Fatalf("last-good backup was lost while rejecting a non-regular primary: data=%q err=%v", backup, err)
	}
}

func TestRemoveFileValidatesBothLeavesBeforeDeleting(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "component.json")
	if err := os.WriteFile(path, []byte("current\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path+".bak", 0700); err != nil {
		t.Fatal(err)
	}
	if err := RemoveFile(path); err == nil {
		t.Fatal("non-regular backup was removed")
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "current\n" {
		t.Fatalf("primary changed before both leaves were validated: data=%q err=%v", data, err)
	}
}

func TestRemoveFileDeletesPrimaryAndBackup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "component.json")
	for _, entry := range []string{path, path + ".bak"} {
		if err := os.WriteFile(entry, []byte("data\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := RemoveFile(path); err != nil {
		t.Fatal(err)
	}
	for _, entry := range []string{path, path + ".bak"} {
		if _, err := os.Lstat(entry); !os.IsNotExist(err) {
			t.Fatalf("managed file remained after removal: %s err=%v", entry, err)
		}
	}
}

func TestReadAndWriteFileRefuseSymlinkTargets(t *testing.T) {
	root := t.TempDir()
	realPath := filepath.Join(root, "real.json")
	linkPath := filepath.Join(root, "link.json")
	if err := os.WriteFile(realPath, []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(realPath, linkPath); err != nil {
		t.Skipf("symlinks are unavailable: %v", err)
	}
	if _, err := ReadFile(linkPath, 64); err == nil {
		t.Fatal("symlink was followed while reading")
	}
	if err := WriteFile(linkPath, []byte("replacement"), 0600); err == nil {
		t.Fatal("symlink was replaced while writing")
	}
}

func TestReadFileRefusesSymlinkBackup(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "settings.json")
	targetPath := filepath.Join(root, "outside.json")
	if err := os.WriteFile(targetPath, []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(targetPath, path+".bak"); err != nil {
		t.Skipf("symlinks are unavailable: %v", err)
	}
	if _, err := ReadFile(path, 64); err == nil {
		t.Fatal("symlink backup was restored")
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("symlink backup created a primary file: %v", err)
	}
}

func TestReadFileRejectsOpenedFileWithDifferentIdentity(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "settings.json")
	otherPath := filepath.Join(root, "other.json")
	if err := os.WriteFile(path, []byte("expected"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(otherPath, []byte("unexpected"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := readFileWithOpener(path, 64, func(string) (*os.File, error) {
		return os.Open(otherPath)
	})
	if err == nil {
		t.Fatal("opened file with a different identity was accepted")
	}
}

func TestRenameCheckedRejectsIdentitySwap(t *testing.T) {
	root := t.TempDir()
	expectedPath := filepath.Join(root, "expected.json")
	sourcePath := filepath.Join(root, "replacement.json")
	destinationPath := filepath.Join(root, "backup.json")
	if err := os.WriteFile(expectedPath, []byte("expected"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sourcePath, []byte("replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	expected, err := os.Lstat(expectedPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := renameChecked(sourcePath, destinationPath, expected); err == nil {
		t.Fatal("renamed file with a different identity was accepted")
	}
}
