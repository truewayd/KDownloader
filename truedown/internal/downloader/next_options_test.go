package downloader

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestNext3RejectsRetiredTaskOptions(t *testing.T) {
	root := t.TempDir()
	m, err := NewManagerWithConfig("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"), ManagerConfig{Aria2Next: true, Aria2NextVersion: "3.0.0"})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	for _, name := range []string{"stream-max-range-size", "bt-resume-save-interval", "auto-save-interval", "state-save-interval"} {
		opts := Aria2Opts{ExtraArgs: []string{"--" + name + "=1"}}
		if _, _, err := m.AddTask("https://example.test/file", "file.bin", "", nil, "", 0, opts); !IsValidationError(err) {
			t.Fatalf("accepted obsolete %s: %v", name, err)
		}
		m.aria2NextVersion = "2.8.3"
		if err := m.validateEngineOptions(opts); err != nil {
			t.Fatal("changed old-engine behavior", err)
		}
		m.aria2NextVersion = "3.0.0"
	}
	args := strings.Join(m.aria2StartArgs(15152, "secret", RuntimeSettings{ConcurrentDownloads: 1}), "\n")
	if !strings.Contains(args, "--state-save-interval=1") || strings.Contains(args, "--auto-save-interval=") || strings.Contains(args, "--bt-resume-save-interval=") {
		t.Fatalf("incorrect NEXT 3 checkpoints: %s", args)
	}
}

func TestNext3OutputPolicyUsesNativeResumeAndRestart(t *testing.T) {
	m := &Manager{aria2Next: true, aria2NextVersion: "3.0.0"}
	for _, restart := range []bool{false, true} {
		options := m.engineTaskOptions(&Task{}, false, restart, false)
		if options["continue"] != "false" || options["auto-file-renaming"] != "false" || options["media"] != "file" {
			t.Fatal("native checkpoint policy permits prefix adoption", options)
		}
		wantOverwrite := "false"
		if restart {
			wantOverwrite = "true"
		}
		if options["allow-overwrite"] != wantOverwrite {
			t.Fatal("incorrect explicit restart policy", options)
		}
		if _, exists := options["remove-control-file"]; exists {
			t.Fatal("sticky reset would break pause/resume")
		}
	}
}
