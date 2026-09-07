//go:build windows

package app

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestReplacementCoreSurvivesOldCoreJobExit(t *testing.T) {
	const roleKey = "TRUEDOWN_TEST_RELAUNCH_ROLE"
	const directoryKey = "TRUEDOWN_TEST_RELAUNCH_DIRECTORY"
	directory := os.Getenv(directoryKey)
	switch os.Getenv(roleKey) {
	case "parent":
		if err := protectCoreProcess(); err != nil {
			t.Fatal(err)
		}
		child := exec.Command(os.Args[0], "-test.run=^TestReplacementCoreSurvivesOldCoreJobExit$")
		child.Env = append(appendWithoutEnvironment(os.Environ(), roleKey), roleKey+"=child")
		configureRelaunchProcess(child)
		if err := child.Start(); err != nil {
			t.Fatal(err)
		}
		_ = child.Process.Release()
		return
	case "child":
		if err := protectCoreProcess(); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(8 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := os.Stat(filepath.Join(directory, "parent-exited")); err == nil {
				if err := os.WriteFile(filepath.Join(directory, "replacement-alive"), []byte("ready"), 0600); err != nil {
					t.Fatal(err)
				}
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatal("parent did not exit within the relaunch deadline")
	}
	directory = t.TempDir()
	parent := exec.Command(os.Args[0], "-test.run=^TestReplacementCoreSurvivesOldCoreJobExit$")
	parent.Env = append(os.Environ(), roleKey+"=parent", directoryKey+"="+directory)
	parent.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if output, err := parent.CombinedOutput(); err != nil {
		t.Fatalf("old core failed: %v, %s", err, output)
	}
	if err := os.WriteFile(filepath.Join(directory, "parent-exited"), []byte("exited"), 0600); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(filepath.Join(directory, "replacement-alive")); err == nil && string(data) == "ready" {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("replacement was killed when the old core's job closed")
}
