package downloader

import (
	"os"
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

func TestIncompleteSuffixRejectedBeforeAdmissionOnEveryEngine(t *testing.T) {
	for _, version := range []string{"", "2.8.3", "3.0.2", "3.0.8"} {
		t.Run("engine-"+version, func(t *testing.T) {
			root := t.TempDir()
			m, err := NewManagerWithConfig("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"), ManagerConfig{Aria2Next: version != "", Aria2NextVersion: version})
			if err != nil {
				t.Fatal(err)
			}
			defer m.Stop()
			for _, raw := range []string{"--incomplete-suffix=.part", "incomplete-suffix=.tmp", "--INCOMPLETE-SUFFIX=.part", "--incomplete-suffix=", "--incomplete-suffix"} {
				opts := Aria2Opts{ExtraArgs: []string{raw}}
				if _, _, err := m.AddTask("https://example.test/file", "file.bin", "", nil, "", 0, opts); !IsValidationError(err) {
					t.Fatalf("accepted %q: %v", raw, err)
				}
				if len(m.ListTasks()) != 0 {
					t.Fatal("rejected option left a durable task")
				}
			}
		})
	}
}

func TestIncompleteSuffixCannotReachDefaultsOrEngine(t *testing.T) {
	defaults := defaultTaskDefaults()
	defaults.Extra = "--incomplete-suffix=.part"
	if err := validateTaskDefaults(defaults); !IsValidationError(err) {
		t.Fatal("unsafe suffix accepted in saved defaults", err)
	}
	// Defense in depth for old persisted requests: serialization must never
	// pass a suffix through even if an admission call is accidentally skipped.
	options := ariaOptions(&Task{OutputName: "file.bin", Opts: Aria2Opts{ExtraArgs: []string{"--INCOMPLETE-SUFFIX=.part"}}}, false)
	if _, exists := options["incomplete-suffix"]; exists || options["out"] != "file.bin" {
		t.Fatal("extra option changed the managed output path", options)
	}
}

func TestIncompleteSuffixReplayPreservesExistingFiles(t *testing.T) {
	m, rpc := transferTestManager(t)
	m.aria2Next, m.aria2NextVersion = true, "3.0.8"
	task, _, err := m.AddTask("https://example.test/file.bin", "file.bin", "", nil, "", 0, Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	m.flushAdmissions(false)
	if err := os.MkdirAll(task.Folder, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(task.Folder, task.OutputName)
	for _, suffix := range []string{"", ".aria2", ".part"} {
		if err := os.WriteFile(path+suffix, []byte("preserve"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	// Simulate a queued request created by an older build. Validation must
	// happen before retry retires the engine result or cleans any owned output.
	m.mu.Lock()
	m.tasks[task.ID].Opts.ExtraArgs = []string{"--incomplete-suffix=.part"}
	m.mu.Unlock()
	before := len(rpc.addedOptions)
	if m.submit(submission{id: task.ID, discardPartial: true, removeGID: task.GID}) {
		t.Fatal("unsafe legacy request reached the engine")
	}
	current, _ := m.GetTask(task.ID)
	if current.Status != StatusError || !strings.Contains(current.Error, "incomplete-suffix") || len(rpc.addedOptions) != before {
		t.Fatalf("legacy suffix did not fail visibly before engine admission: %+v", current)
	}
	for _, suffix := range []string{"", ".aria2", ".part"} {
		if data, err := os.ReadFile(path + suffix); err != nil || string(data) != "preserve" {
			t.Fatal("rejected replay modified existing output", suffix, err)
		}
	}
}
