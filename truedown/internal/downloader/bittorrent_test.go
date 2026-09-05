package downloader

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseTorrentMetainfoDetectsSingleAndMultiFileLayouts(t *testing.T) {
	single, err := parseTorrentMetainfo([]byte("d4:infod6:lengthi4e4:name8:test.binee"))
	if err != nil || single.Name != "test.bin" || single.FileCount != 1 {
		t.Fatalf("single=%+v err=%v", single, err)
	}
	multiData := []byte("d4:infod5:filesld6:lengthi1e4:pathl5:a.txteed6:lengthi2e4:pathl5:b.txteee4:name6:bundleee")
	multi, err := parseTorrentMetainfo(multiData)
	if err != nil || multi.Name != "bundle" || multi.FileCount != 2 {
		t.Fatalf("multi=%+v err=%v", multi, err)
	}
	for _, invalid := range [][]byte{
		{},
		[]byte("not-bencode"),
		[]byte("d4:infod4:name8:../badee"),
		[]byte("d4:infod4:name8:test.binee-trailing"),
	} {
		if _, err := parseTorrentMetainfo(invalid); err == nil {
			t.Fatalf("invalid metainfo %q was accepted", invalid)
		}
	}
}

type torrentRPCStub struct {
	*fakeAriaRPC
	torrent string
	options map[string]any
}

type restoredTorrentRPCStub struct {
	*fakeAriaRPC
	nativeStatus string
}

func (stub *restoredTorrentRPCStub) status(gid string) (ariaStatus, error) {
	return ariaStatus{GID: gid, Status: stub.nativeStatus, Bittorrent: &ariaBitTorrentStatus{}}, nil
}

func TestRestoredTorrentKeepsNativeOutputRoot(t *testing.T) {
	for _, native := range []bool{false, true} {
		t.Run(map[bool]string{false: "resubmit", true: "attach"}[native], func(t *testing.T) {
			root := t.TempDir()
			manager, err := NewManagerWithConfig("unused", root, filepath.Join(root, "records.db"), ManagerConfig{Aria2Next: true})
			if err != nil {
				t.Fatal(err)
			}
			defer manager.Stop()
			task, _, err := manager.AddBitTorrentLink("https://example.test/archive.torrent", root, nil, "", Aria2Opts{})
			if err != nil {
				t.Fatal(err)
			}
			manager.flushAdmissions(false)
			if err := os.Mkdir(filepath.Join(root, "bundle"), 0700); err != nil {
				t.Fatal(err)
			}
			if err := manager.setTask(task.ID, func(task *Task) { task.OutputName = "bundle" }); err != nil {
				t.Fatal(err)
			}
			fake := &fakeAriaRPC{}
			manager.rpc = fake
			if native {
				manager.rpc = &restoredTorrentRPCStub{fakeAriaRPC: fake, nativeStatus: "active"}
			}
			if !manager.submit(submission{id: task.ID}) {
				t.Fatal("restored torrent was not admitted")
			}
			updated, _ := manager.GetTask(task.ID)
			if updated.OutputName != "bundle" {
				t.Fatalf("native torrent root was renamed to %q", updated.OutputName)
			}
			for _, options := range fake.addedOptions {
				if _, exists := options["out"]; exists {
					t.Fatalf("restored torrent must not override its native root: %v", options)
				}
			}
		})
	}
}

func TestRestoredTorrentReconcilesPersistedPauseState(t *testing.T) {
	for _, test := range []struct {
		name            string
		local           Status
		native          string
		pauses, resumes int
	}{
		{"pause-active", StatusPaused, "active", 1, 0},
		{"pause-waiting", StatusPaused, "waiting", 1, 0},
		{"resume-paused", StatusQueued, "paused", 0, 1},
		{"keep-paused", StatusPaused, "paused", 0, 0},
		{"keep-complete", StatusQueued, "complete", 0, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			manager, err := NewManagerWithConfig("unused", root, filepath.Join(root, "records.db"), ManagerConfig{Aria2Next: true})
			if err != nil {
				t.Fatal(err)
			}
			defer manager.Stop()
			task, _, err := manager.AddBitTorrentLink("https://example.test/archive.torrent", root, nil, "", Aria2Opts{})
			if err != nil {
				t.Fatal(err)
			}
			manager.flushAdmissions(false)
			if err := manager.setTask(task.ID, func(task *Task) { task.Status = test.local }); err != nil {
				t.Fatal(err)
			}
			fake := &fakeAriaRPC{}
			manager.rpc = &restoredTorrentRPCStub{fakeAriaRPC: fake, nativeStatus: test.native}
			if !manager.submit(submission{id: task.ID}) {
				t.Fatal("native torrent was not attached")
			}
			if len(fake.paused) != test.pauses || len(fake.resumed) != test.resumes || len(fake.added) != 0 {
				t.Fatalf("pause calls=%v resume calls=%v added=%d", fake.paused, fake.resumed, len(fake.added))
			}
		})
	}
}

func (stub *torrentRPCStub) addTorrent(_ *Task, torrent string, options map[string]any) error {
	stub.torrent = torrent
	stub.options = options
	return nil
}

func TestImportedTorrentPersistsAndUsesAddTorrentWithIntegrityCheck(t *testing.T) {
	root := t.TempDir()
	databasePath := filepath.Join(root, "records.db")
	manager, err := NewManagerWithConfig("unused", filepath.Join(root, "downloads"), databasePath, ManagerConfig{Aria2Next: true})
	if err != nil {
		t.Fatal(err)
	}
	data := []byte("d4:infod6:lengthi4e4:name8:test.binee")
	task, duplicate, err := manager.AddTorrentMetainfo(data, filepath.Join(root, "chosen"), Aria2Opts{})
	if err != nil || duplicate {
		t.Fatalf("task=%+v duplicate=%v err=%v", task, duplicate, err)
	}
	duplicateTask, duplicate, err := manager.AddTorrentMetainfo(data, filepath.Join(root, "chosen"), Aria2Opts{})
	if err != nil || !duplicate || duplicateTask.ID != task.ID {
		t.Fatalf("duplicate task=%+v duplicate=%v err=%v", duplicateTask, duplicate, err)
	}
	manager.flushAdmissions(false)
	stub := &torrentRPCStub{fakeAriaRPC: &fakeAriaRPC{}}
	manager.rpc = stub
	if !manager.submit(submission{id: task.ID}) {
		t.Fatal("imported torrent was not admitted")
	}
	if stub.torrent != base64.StdEncoding.EncodeToString(data) || stub.options["check-integrity"] != "true" ||
		stub.options["dir"] != filepath.ToSlash(filepath.Join(root, "chosen")) {
		t.Fatalf("torrent=%q options=%v", stub.torrent, stub.options)
	}
	if _, exists := stub.options["out"]; exists {
		t.Fatalf("BitTorrent task unexpectedly forced an output name: %v", stub.options)
	}
	manager.Stop()

	reloaded, err := NewManagerWithConfig("unused", filepath.Join(root, "downloads"), databasePath, ManagerConfig{Aria2Next: true})
	if err != nil {
		t.Fatal(err)
	}
	defer reloaded.Stop()
	tasks := reloaded.ListTasks()
	if len(tasks) != 1 || !strings.HasPrefix(tasks[0].Link, "torrent://") || !strings.Contains(tasks[0].RequestJSON, "torrentBase64") {
		t.Fatalf("reloaded tasks=%+v", tasks)
	}
}

func TestApplyStatusesFollowsTorrentChildGID(t *testing.T) {
	root := t.TempDir()
	manager, err := NewManagerWithConfig("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"), ManagerConfig{Aria2Next: true})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Stop()
	task, _, err := manager.AddBitTorrentLink("https://example.test/archive.torrent", filepath.Join(root, "chosen"), nil, "", Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	manager.flushAdmissions(false)
	childGID := "fedcba9876543210"
	parent := ariaStatus{GID: task.GID, Status: "complete", FollowedBy: []string{childGID}}
	child := ariaStatus{GID: childGID, Status: "active", TotalLength: "100", CompletedLength: "25"}
	child.Bittorrent = &ariaBitTorrentStatus{AnnounceList: [][]string{{"udp://tracker.example:80/announce"}}}
	manager.applyStatusesAtRevision([]ariaStatus{parent, child}, manager.revision)
	updated, ok := manager.GetTask(task.ID)
	if !ok || updated.GID != childGID || updated.Status != StatusDownloading || !strings.Contains(updated.Progress, "25.0%") {
		t.Fatalf("updated task=%+v", updated)
	}
	manager.Stop()

	reloaded, err := NewManagerWithConfig("unused", filepath.Join(root, "other-downloads"), filepath.Join(root, "records.db"), ManagerConfig{Aria2Next: true})
	if err != nil {
		t.Fatal(err)
	}
	defer reloaded.Stop()
	persisted, ok := reloaded.GetTask(task.ID)
	if !ok || persisted.GID != childGID {
		t.Fatalf("persisted task=%+v", persisted)
	}
}

func TestTorrentMetadataCompletionWaitsForChildOutsidePollingSnapshot(t *testing.T) {
	root := t.TempDir()
	manager, err := NewManagerWithConfig("unused", root, filepath.Join(root, "records.db"), ManagerConfig{Aria2Next: true})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Stop()
	task, _, err := manager.AddBitTorrentLink("https://example.test/archive.torrent", root, nil, "", Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	manager.flushAdmissions(false)
	manager.rpc = &fakeAriaRPC{}
	if !manager.acquireAriaSlot() || !manager.submit(submission{id: task.ID}) {
		t.Fatal("torrent was not admitted")
	}
	childGID := "fedcba9876543210"
	manager.applyStatuses([]ariaStatus{{GID: task.GID, Status: "complete", FollowedBy: []string{childGID}}})
	pending, _ := manager.GetTask(task.ID)
	if pending.GID != childGID || pending.Status != StatusQueued || len(manager.ariaSlots) != 1 {
		t.Fatalf("metadata completion lost its pending child or admission slot: task=%+v slots=%d", pending, len(manager.ariaSlots))
	}
	manager.applyStatuses([]ariaStatus{{GID: childGID, Status: "active", Bittorrent: &ariaBitTorrentStatus{}, TotalLength: "100", CompletedLength: "25"}})
	active, _ := manager.GetTask(task.ID)
	if active.Status != StatusDownloading || !strings.Contains(active.Progress, "25.0%") {
		t.Fatalf("later child status was lost: %+v", active)
	}
	manager.applyStatuses([]ariaStatus{{GID: childGID, Status: "complete", Bittorrent: &ariaBitTorrentStatus{}}})
	if len(manager.ariaSlots) != 0 {
		t.Fatal("completed child did not release its admission slot")
	}
}

func TestBitTorrentLinkValidationAcceptsMagnetAndRejectsNonBTURI(t *testing.T) {
	accepted := []string{
		"magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=sample",
		"magnet:?xt=urn:btmh:1220abcdef",
		"https://example.test/sample.torrent",
	}
	for _, link := range accepted {
		if err := validateBitTorrentLink(link); err != nil {
			t.Fatalf("link %q rejected: %v", link, err)
		}
	}
	for _, link := range []string{"magnet:?dn=missing-hash", "ftp://example.test/a.torrent", "file:///tmp/a.torrent"} {
		if err := validateBitTorrentLink(link); err == nil {
			t.Fatalf("link %q was accepted", link)
		}
	}
}

func TestAria2NextStartArgsEnableDurableTorrentVerification(t *testing.T) {
	root := t.TempDir()
	stateDir := filepath.Join(root, "aria2-next-state")
	manager := &Manager{
		aria2Next:        true,
		aria2NextVersion: "2.6.0",
		ariaStateDir:     stateDir,
		defaultDir:       filepath.Join(root, "downloads"),
	}
	args := manager.aria2StartArgs(15152, "secret", RuntimeSettings{ConcurrentDownloads: 3})
	joined := strings.Join(args, "\n")
	if !strings.Contains(joined, "--auto-save-interval=5") {
		t.Fatalf("engine args do not bound crash recovery loss: %v", args)
	}
	for _, expected := range []string{
		"--state-dir=" + filepath.ToSlash(stateDir),
		"--check-integrity=true",
		"--bt-resume-save-interval=1",
	} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("missing %q in args=%v", expected, args)
		}
	}
	if strings.Contains(joined, "--bt-session-state-file=") {
		t.Fatalf("Aria2 Next 2.6 received the legacy session-state arg: %s", joined)
	}
	legacy := &Manager{
		aria2Next:        true,
		aria2NextVersion: "2.5.6",
		ariaStateDir:     stateDir,
		defaultDir:       manager.defaultDir,
	}
	legacyArgs := strings.Join(legacy.aria2StartArgs(15152, "secret", RuntimeSettings{ConcurrentDownloads: 3}), "\n")
	if !strings.Contains(legacyArgs, "--check-integrity=true") || strings.Contains(legacyArgs, "--state-dir=") ||
		strings.Contains(legacyArgs, "--bt-session-state-file=") || strings.Contains(legacyArgs, "--bt-resume-save-interval=") {
		t.Fatalf("Aria2 Next 2.5.6 received incompatible native-state args: %s", legacyArgs)
	}
	researchCapable := &Manager{
		aria2Next:        true,
		aria2NextVersion: "2.5.7",
		ariaStateDir:     stateDir,
		defaultDir:       manager.defaultDir,
	}
	researchArgs := strings.Join(researchCapable.aria2StartArgs(15152, "secret", RuntimeSettings{ConcurrentDownloads: 3}), "\n")
	if strings.Contains(researchArgs, "--state-dir=") ||
		!strings.Contains(researchArgs, "--bt-session-state-file="+filepath.ToSlash(filepath.Join(stateDir, "bittorrent.session"))) ||
		!strings.Contains(researchArgs, "--bt-resume-save-interval=1") {
		t.Fatalf("Aria2 Next 2.5.7 received incorrect native-state args: %s", researchArgs)
	}
	stable := &Manager{defaultDir: manager.defaultDir}
	if stableArgs := strings.Join(stable.aria2StartArgs(15152, "secret", RuntimeSettings{ConcurrentDownloads: 3}), "\n"); strings.Contains(stableArgs, "--state-dir=") || strings.Contains(stableArgs, "--bt-session-state-file=") || strings.Contains(stableArgs, "--bt-resume-save-interval=") {
		t.Fatalf("stable engine received NEXT-only args: %s", stableArgs)
	}
	diagnostic := &Manager{
		aria2Next:        true,
		aria2NextVersion: "2.6.5",
		ariaStateDir:     stateDir,
		defaultDir:       manager.defaultDir,
	}
	diagnosticArgs := strings.Join(diagnostic.aria2StartArgs(15152, "secret", RuntimeSettings{ConcurrentDownloads: 3}), "\n")
	for _, expected := range []string{
		"--log=" + filepath.ToSlash(filepath.Join(root, "aria2.log")),
		"--log-level=debug",
		"--log-max-size=10M",
		"--log-max-files=4",
		"--console-log-level=warn",
		"--summary-interval=0",
	} {
		if !strings.Contains(diagnosticArgs, expected) {
			t.Fatalf("missing diagnostic option %q in args=%v", expected, diagnostic.aria2StartArgs(15152, "secret", RuntimeSettings{ConcurrentDownloads: 3}))
		}
	}
	if strings.Contains(joined, "--log-level=debug") || !strings.Contains(joined, "--console-log-level=info") || !strings.Contains(joined, "--summary-interval=5") {
		t.Fatalf("Aria2 Next 2.6.0 logging args are incorrect: %s", joined)
	}
}

func TestBitTorrentProgressIncludesZeroSpeedDiscoveryDiagnostics(t *testing.T) {
	state := ariaStatus{
		Status:          "active",
		TotalLength:     "1048576",
		CompletedLength: "0",
		DownloadSpeed:   "0",
		Connections:     "2",
		NumSeeders:      "1",
	}
	state.Bittorrent = &ariaBitTorrentStatus{
		AnnounceList:      [][]string{{"udp://tracker.example/announce"}, {"https://tracker.example/announce"}},
		State:             "downloading",
		NumPeers:          "2",
		ConnectingPeers:   "1",
		HandshakingPeers:  "1",
		NumSeeds:          "1",
		ConnectCandidates: "4",
		Availability:      "0.75",
	}
	progress := formatProgress(state)
	for _, expected := range []string{"0 B/s", "BT downloading: 2 peers, 1 seeds, 2 trackers", "1 connecting", "1 handshaking", "4 candidates", "availability 75.0%"} {
		if !strings.Contains(progress, expected) {
			t.Fatalf("progress %q is missing %q", progress, expected)
		}
	}
}

func TestTaskOutputRootNamePreservesMultiFileTorrentDirectory(t *testing.T) {
	root := t.TempDir()
	if got := taskOutputRootName(root, filepath.Join(root, "bundle", "nested", "a.bin")); got != "bundle" {
		t.Fatalf("multi-file root=%q", got)
	}
	if got := taskOutputRootName(root, filepath.Join(root, "single.bin")); got != "single.bin" {
		t.Fatalf("single-file root=%q", got)
	}
	if got := taskOutputRootName(root, filepath.Join("bundle", "a.bin")); got != "bundle" {
		t.Fatalf("relative multi-file root=%q", got)
	}
}
