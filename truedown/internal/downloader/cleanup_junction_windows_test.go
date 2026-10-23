//go:build windows

package downloader

import (
	"fmt"
	"golang.org/x/sys/windows"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestRestoredShortPathAliasesPreserveEveryOwner(t *testing.T) {
	for _, leafAlias := range []bool{false, true} {
		for _, chosen := range []int{0, 1} {
			t.Run(fmt.Sprintf("leaf=%v/owner=%d", leafAlias, chosen), func(t *testing.T) {
				var original string
				m, tasks := restoredOverlappingTasksWith(t, func(tasks []*Task) {
					folder := filepath.Join(tasks[0].Folder, "long-directory-for-alias-test")
					if err := os.MkdirAll(folder, 0700); err != nil {
						t.Fatal(err)
					}
					name := "long-payload-for-alias-test.bin"
					original = filepath.Join(folder, name)
					for _, suffix := range []string{"", ".aria2"} {
						if err := os.WriteFile(original+suffix, []byte("shared"), 0600); err != nil {
							t.Fatal(err)
						}
					}
					source := folder
					if leafAlias {
						source = original
					}
					input, err := windows.UTF16PtrFromString(source)
					if err != nil {
						t.Fatal(err)
					}
					buffer := make([]uint16, 32768)
					n, err := windows.GetShortPathName(input, &buffer[0], uint32(len(buffer)))
					if err != nil || n >= uint32(len(buffer)) {
						t.Fatalf("short path: %v %d", err, n)
					}
					short := windows.UTF16ToString(buffer[:n])
					if strings.EqualFold(short, source) {
						t.Skip("8.3 names disabled on fixture volume")
					}
					for _, task := range tasks {
						task.Folder, task.OutputName = folder, name
					}
					if leafAlias {
						tasks[1].OutputName = filepath.Base(short)
					} else {
						tasks[1].Folder = short
					}
				})
				result := m.RemoveTasks([]int64{tasks[chosen].ID})
				if len(result.Failed) != 1 || !strings.Contains(result.Failed[0].Error, "filesystem alias") {
					t.Fatalf("alias removal: %+v", result)
				}
				for _, suffix := range []string{"", ".aria2"} {
					if data, err := os.ReadFile(original + suffix); err != nil || string(data) != "shared" {
						t.Fatalf("shared bytes changed: %q %v", data, err)
					}
				}
				if stored, err := m.store.LoadAll(); err != nil || len(stored) != 2 {
					t.Fatalf("lost records: %v %v", stored, err)
				}
			})
		}
	}
}

func TestCleanupRejectsWindowsJunction(t *testing.T) {
	base := artifactTempDir(t)
	real, alias := filepath.Join(base, "real"), filepath.Join(base, "alias")
	if err := os.Mkdir(real, 0700); err != nil {
		t.Fatal(err)
	}
	command := exec.Command("cmd.exe", "/c", "mklink", "/J", alias, real)
	configureManagedProcess(command)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("create fixture junction: %v %s", err, output)
	}
	for _, suffix := range []string{"", ".aria2"} {
		if err := os.WriteFile(filepath.Join(real, "file.bin"+suffix), []byte("foreign"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := removePartialFiles(&Task{Folder: alias, OutputName: "file.bin"}, ""); err == nil || !strings.Contains(err.Error(), "contains a link") {
		t.Fatalf("junction was not diagnosed: %v", err)
	}
	for _, suffix := range []string{"", ".aria2"} {
		if data, err := os.ReadFile(filepath.Join(real, "file.bin"+suffix)); err != nil || string(data) != "foreign" {
			t.Fatalf("foreign pair changed: %q %v", data, err)
		}
	}
}
