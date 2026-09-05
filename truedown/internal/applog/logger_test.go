package applog

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestLoggerReturnsBoundedCompleteTail(t *testing.T) {
	logger, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer logger.Close()
	if _, err := logger.Write([]byte("first line\nsecond line\nthird line\n")); err != nil {
		t.Fatal(err)
	}
	content, truncated, _, err := logger.ReadTail(16)
	if err != nil {
		t.Fatal(err)
	}
	if !truncated || content != "third line\n" {
		t.Fatalf("tail=%q truncated=%v", content, truncated)
	}
}

func TestLoggerRotatesWithoutFollowingManagedLinks(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, fileName)
	if err := os.WriteFile(path, []byte(strings.Repeat("x", int(maximumBytes))), 0600); err != nil {
		t.Fatal(err)
	}
	logger, err := Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	logger.Close()
	if info, err := os.Stat(path + ".1"); err != nil || info.Size() != maximumBytes {
		t.Fatalf("rotated log info=%v err=%v", info, err)
	}

	linkTarget := filepath.Join(directory, "outside.log")
	if err := os.WriteFile(linkTarget, []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(linkTarget, path); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if _, err := Open(directory); err == nil {
		t.Fatal("logger followed a managed log symlink")
	}
}

func TestLoggerTruncatesOneOversizedEntryAtAUTF8Boundary(t *testing.T) {
	logger, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer logger.Close()
	entry := []byte(strings.Repeat("界", maximumWrite))
	if written, err := logger.Write(entry); err != nil || written != len(entry) {
		t.Fatalf("Write()=(%d, %v), want (%d, nil)", written, err, len(entry))
	}
	content, _, _, err := logger.ReadTail(maximumBytes)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(content, "\n[log entry truncated]\n") || strings.ContainsRune(content, '\uFFFD') {
		t.Fatalf("oversized log entry was not safely truncated: suffix=%q", content[len(content)-32:])
	}
}

func TestOversizedMalformedLogPreservesDiagnosticText(t *testing.T) {
	logger, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer logger.Close()
	entry := []byte(strings.Repeat("a", maximumWrite/2) + "\xff useful diagnostic " + strings.Repeat("z", maximumWrite))
	if _, err := logger.Write(entry); err != nil {
		t.Fatal(err)
	}
	content, _, _, err := logger.ReadTail(maximumBytes)
	if err != nil || !strings.Contains(content, "useful diagnostic") || !utf8.ValidString(content) {
		t.Fatalf("malformed log lost its diagnostic text or UTF-8 validity: err=%v length=%d", err, len(content))
	}
}

func TestMalformedLogTailStaysWithinByteLimit(t *testing.T) {
	logger, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer logger.Close()
	if _, err := logger.Write([]byte(strings.Repeat("\xffx", 100))); err != nil {
		t.Fatal(err)
	}
	content, truncated, _, err := logger.ReadTail(32)
	if err != nil || !truncated || len(content) > 32 || !utf8.ValidString(content) || !strings.HasSuffix(content, "x") {
		t.Fatalf("tail length=%d truncated=%v valid=%v err=%v", len(content), truncated, utf8.ValidString(content), err)
	}
}
