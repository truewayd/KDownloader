package downloader

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

func TestHTTPControlInspectionDistinguishesCorruptionFromValidResume(t *testing.T) {
	valid := make([]byte, 39)
	valid[1] = 1
	binary.BigEndian.PutUint32(valid[10:14], 1024*1024)
	binary.BigEndian.PutUint64(valid[14:22], 1024*1024)
	binary.BigEndian.PutUint32(valid[30:34], 1)
	withPiece := append(append([]byte(nil), valid...), make([]byte, 20)...)
	binary.BigEndian.PutUint32(withPiece[35:39], 1)
	binary.BigEndian.PutUint32(withPiece[43:47], 1024*1024)
	binary.BigEndian.PutUint32(withPiece[47:51], 8)
	changed := func(offset int, value byte) []byte {
		data := append([]byte(nil), valid...)
		data[offset] = value
		return data
	}
	for _, test := range []struct {
		name    string
		data    []byte
		remote  string
		invalid bool
	}{
		{"valid", valid, "1048576", false},
		{"valid-inflight", withPiece, "1048576", false},
		{"remote-changed", valid, "1048577", true},
		{"empty", nil, "", true},
		{"bad-version", []byte{0xff, 0xff}, "", true},
		{"short-header", valid[:20], "", true},
		{"short-bitmap", valid[:34], "", true},
		{"short-inflight", withPiece[:52], "", true},
		{"wrong-bitmap-length", changed(33, 2), "", true},
		{"invalid-hash-length", changed(9, 21), "", true},
		{"invalid-inflight-count", changed(38, 255), "", true},
		{"future-layout", changed(1, 2), "", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			task := &Task{Folder: t.TempDir(), OutputName: "file.bin"}
			if err := os.WriteFile(filepath.Join(task.Folder, task.OutputName+".aria2"), test.data, 0600); err != nil {
				t.Fatal(err)
			}
			if got := invalidHTTPResumeControl(task, test.remote); got != test.invalid {
				t.Fatalf("invalid=%v want=%v", got, test.invalid)
			}
		})
	}
}

func TestHTTPControlInspectionDoesNotAdoptDirectoryOrSymlink(t *testing.T) {
	task := &Task{Folder: t.TempDir(), OutputName: "file.bin"}
	path := filepath.Join(task.Folder, task.OutputName+".aria2")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if invalidHTTPResumeControl(task, "") {
		t.Fatal("non-file control path treated as disposable corruption")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(task.Folder, "missing-target"), path); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if invalidHTTPResumeControl(task, "") || outputNameAvailable(task.Folder, task.OutputName) {
		t.Fatal("dangling symlink was treated as a usable output")
	}
}
