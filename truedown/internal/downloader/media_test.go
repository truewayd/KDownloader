package downloader

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

type fakeMediaRPC struct {
	*fakeAriaRPC
	mediaState           string
	retries, retirements int
}

func (rpc *fakeMediaRPC) capabilities() EngineCapabilities {
	return EngineCapabilities{Media: true, Probe: true}
}
func (rpc *fakeMediaRPC) status(gid string) (ariaStatus, error) {
	if rpc.mediaState == "" {
		return ariaStatus{}, &ariaRPCError{Code: 1, Message: "GID " + gid + " is not found"}
	}
	return ariaStatus{GID: gid, Status: rpc.mediaState, Media: &ariaMediaStatus{Protocol: "hls", State: rpc.mediaState}}, nil
}
func (rpc *fakeMediaRPC) retryMedia(string, map[string]any) error {
	rpc.retries++
	rpc.mediaState = "waiting"
	return nil
}
func (rpc *fakeMediaRPC) finishMedia(string) error  { return nil }
func (rpc *fakeMediaRPC) removeResult(string) error { rpc.retirements++; return nil }

func TestMediaAdmissionAndRetryOwnership(t *testing.T) {
	m, base := transferTestManager(t)
	m.aria2Next, m.aria2NextVersion = true, "3.0.0"
	rpc := &fakeMediaRPC{fakeAriaRPC: base}
	m.rpc = rpc
	for _, opts := range []Aria2Opts{
		{Media: &MediaOptions{Protocol: "auto"}}, {Media: &MediaOptions{Protocol: "hls", Format: "exe"}},
		{Media: &MediaOptions{Protocol: "dash", RecordTime: -1}}, {ExtraArgs: []string{"media=hls"}},
		{Media: &MediaOptions{Protocol: "hls"}, ExtraArgs: []string{"checksum=sha-256=abc"}},
	} {
		if _, _, err := m.AddTask("https://example.test/index", "movie", "", nil, "", 0, opts); !IsValidationError(err) {
			t.Fatal("invalid media admitted", opts, err)
		}
	}
	task, _, err := m.AddTask("https://example.test/index", "Episode.01", "", map[string]string{"Cookie": "secret"}, "https://example.test/page", 0, Aria2Opts{Media: &MediaOptions{Protocol: "hls", Format: "mkv"}})
	if err != nil {
		t.Fatal(err)
	}
	m.flushAdmissions(false)
	if !m.submit(submission{id: task.ID}) {
		t.Fatal("media submission failed")
	}
	options := base.addedOptions[0]
	if options["media"] != "hls" || options["media-format"] != "mkv" || options["filename-hint"] != "Episode.01" || options["auto-file-renaming"] != "true" || options["allow-overwrite"] != "false" || options["out"] != nil {
		t.Fatal("manager overrode native naming/publication", options)
	}
	rpc.mediaState = "error"
	m.applyStatuses([]ariaStatus{{GID: task.GID, Status: "error", ErrorCode: "13", ErrorMessage: "Cookie: secret", Media: &ariaMediaStatus{State: "error", Protocol: "hls", ErrorCode: "protected_media"}}})
	failed, _ := m.GetTask(task.ID)
	if failed.TransferState == transferRestart || strings.Contains(failed.Error, "secret") {
		t.Fatal("media entered HTTP cleanup or leaked credentials", failed)
	}
	if err := m.RequeueTask(task.ID); err != nil {
		t.Fatal(err)
	}
	queued, _ := m.GetTask(task.ID)
	if queued.GID != task.GID || queued.PreviousGID != task.GID {
		t.Fatal("lost native retry identity", queued)
	}
	if !m.submit(submission{id: task.ID}) {
		t.Fatal("native media retry failed")
	}
	if rpc.retries != 1 || rpc.retirements != 0 || len(base.added) != 1 {
		t.Fatalf("native retry bypassed: retries=%d retired=%d adds=%d", rpc.retries, rpc.retirements, len(base.added))
	}
	data, _ := json.Marshal(m.snapshotTask(failed))
	if strings.Contains(string(data), "secret") {
		t.Fatal("snapshot exposed private data")
	}
}

func TestMediaSnapshotUsesDurationAndBoundsErrors(t *testing.T) {
	progress := mediaProgress(&ariaMediaStatus{State: "recording", Protocol: "dash", Live: "true", Progress: "NaN", Duration: "-1", CompletedDuration: "24000", DownloadedLength: "1024", ErrorCode: strings.Repeat("secret", 10)})
	if progress.Progress != 0 || progress.Duration != 0 || progress.ErrorCode != "media_failed" || strings.Contains(formatMediaProgress(progress), "%") {
		t.Fatal(progress)
	}
}

func TestMediaWaitsDurablyForEngineWithoutLosingPauseIntent(t *testing.T) {
	root := t.TempDir()
	db := filepath.Join(root, "records.db")
	dir := filepath.Join(root, "downloads")
	m, err := NewManager("unused", dir, db)
	if err != nil {
		t.Fatal(err)
	}
	var ids []int64
	for _, paused := range []bool{false, true} {
		link := "https://example.test/start.m3u8"
		if paused {
			link = "https://example.test/paused.m3u8"
		}
		task, _, err := m.AddTask(link, "", "", nil, "", 0, Aria2Opts{startPaused: paused, Media: &MediaOptions{Protocol: "hls"}})
		if err != nil {
			m.Stop()
			t.Fatal(err)
		}
		ids = append(ids, task.ID)
		if !m.snapshotTask(task).RequiresMediaEngine || m.submit(submission{id: task.ID}) {
			m.Stop()
			t.Fatal("legacy engine was asked to download media")
		}
	}
	if issues := m.DownloadIssues(); issues.EngineRequired != 2 || issues.Downloads != 0 {
		t.Fatal(issues)
	}
	m.flushAdmissions(false)
	m.Stop()
	m, err = NewManagerWithConfig("unused", dir, db, ManagerConfig{Aria2Next: true, Aria2NextVersion: "3.0.0"})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	rpc := &fakeMediaRPC{fakeAriaRPC: &fakeAriaRPC{}}
	m.rpc = rpc
	for index, id := range ids {
		task, _ := m.GetTask(id)
		want := StatusQueued
		if index == 1 {
			want = StatusPaused
		}
		if task.Status != want || m.snapshotTask(task).RequiresMediaEngine {
			t.Fatalf("lost retained intent: %+v", task)
		}
		if !m.submit(submission{id: id}) {
			t.Fatal("compatible engine did not admit retained task")
		}
	}
	if len(rpc.addedOptions) != 2 || rpc.addedOptions[0]["pause"] != "false" || rpc.addedOptions[1]["pause"] != "true" {
		t.Fatal(rpc.addedOptions)
	}
}
