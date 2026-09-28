//go:build windows

package downloader

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestPathOpenHelperRejectsInvalidArguments(t *testing.T) {
	for _, args := range [][]string{
		{openPathHelperFlag}, {openPathHelperFlag, "relative.txt"},
		{openPathHelperFlag, "https://example.test"},
		{openPathHelperFlag, `C:\file.txt`, "extra"},
		{openPathHelperFlag, "C:\\file\x00.txt"},
		{openPathHelperFlag, `C:\` + strings.Repeat("x", 32768)},
	} {
		if handled, err := RunPathOpenHelper(args); !handled || err == nil {
			t.Fatalf("invalid helper request accepted: %v, %v", handled, err)
		}
	}
	if handled, err := RunPathOpenHelper([]string{"--version"}); handled || err != nil {
		t.Fatalf("ordinary startup intercepted: %v, %v", handled, err)
	}
}

func TestPathOpenHelperFailureReachesCaller(t *testing.T) {
	started := time.Now()
	err := systemOpenPath(filepath.Join(t.TempDir(), "missing-file.txt"))
	if err == nil || !strings.Contains(err.Error(), "inspect open target") {
		t.Fatalf("missing target must report validation failure: %v", err)
	}
	if len(pathOpenSlots) != 0 {
		t.Fatal("failed opener retained its concurrency slot")
	}
	t.Logf("private helper startup and path validation: %s", time.Since(started))
}

func TestPathOpenRejectsForeignParentAndOversizedInput(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	source, err := os.Open(self)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	copyPath := filepath.Join(t.TempDir(), "foreign-helper.exe")
	copyFile, err := os.Create(copyPath)
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.Copy(copyFile, source)
	closeErr := copyFile.Close()
	if err != nil || closeErr != nil {
		t.Fatalf("copy fixture: %v, %v", err, closeErr)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, copyPath, openPathHelperFlag)
	configurePathOpenProcess(command)
	command.Stdin = strings.NewReader(`C:\Windows`)
	if output, err := command.CombinedOutput(); err == nil || !strings.Contains(string(output), "only its live core process") {
		t.Fatalf("foreign parent accepted: %v: %s", err, output)
	}
	if err := systemOpenPath(strings.Repeat("x", 32769)); err == nil || !strings.Contains(err.Error(), "invalid path opener request") {
		t.Fatalf("oversized pipe request accepted: %v", err)
	}
}

func TestPathOpenConcurrencyAndOutputAreBounded(t *testing.T) {
	for range cap(pathOpenSlots) {
		pathOpenSlots <- struct{}{}
	}
	defer func() {
		for range cap(pathOpenSlots) {
			<-pathOpenSlots
		}
	}()
	if err := systemOpenPath(`C:\unused.txt`); err == nil || !strings.Contains(err.Error(), "still opening") {
		t.Fatalf("busy opener should reject without spawning: %v", err)
	}
	var output pathOpenOutput
	value := []byte(strings.Repeat("x", 8192))
	if count, err := output.Write(value); err != nil || count != len(value) || len(output) != 4096 {
		t.Fatalf("unbounded helper diagnostics: %d, %d, %v", count, len(output), err)
	}
}

func TestPathOpenSurvivesCoreExit(t *testing.T) {
	const key = "TRUEDOWN_TEST_PATH_OPEN_DIR"
	if directory := os.Getenv(key); directory != "" {
		job, err := windows.CreateJobObject(nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
		limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | windows.JOB_OBJECT_LIMIT_BREAKAWAY_OK
		if _, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
			t.Fatal(err)
		}
		if err = windows.AssignProcessToJobObject(job, windows.CurrentProcess()); err != nil {
			t.Fatal(err)
		}
		// Leave this non-inheritable handle alive until the fixture core exits.
		started := time.Now()
		// Exercise the same breakaway flags with a hidden fixture, never ask the
		// production path opener to execute a program (which it must reject).
		child := exec.Command(filepath.Join(directory, "target with spaces.exe"))
		configurePathOpenProcess(child)
		if err := child.Start(); err != nil {
			t.Fatal(err)
		}
		_ = child.Process.Release()
		t.Logf("detached hidden helper startup: %s", time.Since(started))
		if _, err := os.Stat(filepath.Join(directory, "survived")); err == nil {
			t.Fatal("opener waited for target exit")
		}
		return
	}
	directory := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	build := exec.CommandContext(ctx, "go", "build", "-ldflags=-H=windowsgui", "-o", filepath.Join(directory, "target with spaces.exe"), "./testdata/path-opener")
	build.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build hidden fixture: %v: %s", err, output)
	}
	parent := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestPathOpenSurvivesCoreExit$", "-test.v")
	parent.Env = append(os.Environ(), key+"="+directory)
	parent.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	started := time.Now()
	if output, err := parent.CombinedOutput(); err != nil {
		t.Fatalf("fixture core: %v: %s", err, output)
	} else {
		t.Logf("%s", output)
	}
	waitForPathMarker(t, filepath.Join(directory, "started"))
	t.Logf("fixture core and detached helper startup: %s", time.Since(started))
	if err := os.WriteFile(filepath.Join(directory, "parent-exited"), []byte("exited"), 0600); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(filepath.Join(directory, "survived")); err == nil {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("detached helper did not survive core exit")
}

func waitForPathMarker(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("hidden target did not create %s", filepath.Base(path))
}
