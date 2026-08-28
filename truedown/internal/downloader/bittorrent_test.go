package downloader

import (
	"encoding/base64"
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
	child.Bittorrent = &struct {
		AnnounceList [][]string `json:"announceList"`
	}{AnnounceList: [][]string{{"udp://tracker.example:80/announce"}}}
	manager.applyStatuses([]ariaStatus{parent, child})
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
		aria2Next:    true,
		ariaStateDir: stateDir,
		defaultDir:   filepath.Join(root, "downloads"),
	}
	args := manager.aria2StartArgs(15152, "secret", RuntimeSettings{ConcurrentDownloads: 3})
	joined := strings.Join(args, "\n")
	for _, expected := range []string{
		"--state-dir=" + filepath.ToSlash(stateDir),
		"--check-integrity=true",
		"--bt-resume-save-interval=1",
	} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("missing %q in args=%v", expected, args)
		}
	}
	stable := &Manager{defaultDir: manager.defaultDir}
	if stableArgs := strings.Join(stable.aria2StartArgs(15152, "secret", RuntimeSettings{ConcurrentDownloads: 3}), "\n"); strings.Contains(stableArgs, "--state-dir=") || strings.Contains(stableArgs, "--bt-resume-save-interval=") {
		t.Fatalf("stable engine received NEXT-only args: %s", stableArgs)
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
