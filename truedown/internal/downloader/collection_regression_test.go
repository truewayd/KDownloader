package downloader

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

type completedRemovalRPC struct {
	*fakeAriaRPC
	retireCalls atomic.Int64
}

func (rpc *completedRemovalRPC) removeResult(string) error { rpc.retireCalls.Add(1); return nil }

func TestBulkCompletedRemovalAvoidsPerTaskEngineRPC(t *testing.T) {
	m, fake := transferTestManager(t)
	rpc := &completedRemovalRPC{fakeAriaRPC: fake}
	m.rpc = rpc
	requests := make([]taskAddRequest, 513)
	for index := range requests {
		requests[index] = taskAddRequest{Link: fmt.Sprintf("https://example.test/%d", index), Name: fmt.Sprintf("file-%d.bin", index)}
	}
	added, err := m.addTasksBatch(requests)
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]int64, 0, len(added))
	m.mu.Lock()
	for _, item := range added {
		task := m.tasks[item.Task.ID]
		m.setStatusLocked(task, StatusDone)
		ids = append(ids, task.ID)
	}
	m.mu.Unlock()
	result := m.RemoveTasks(ids)
	if len(result.Succeeded) != len(ids) || len(result.Failed) != 0 || rpc.retireCalls.Load() != 0 {
		t.Fatalf("removed=%d failed=%v RPC=%d", len(result.Succeeded), result.Failed, rpc.retireCalls.Load())
	}
	records, err := m.store.LoadAll()
	if err != nil || len(records) != 0 {
		t.Fatalf("retained=%d error=%v", len(records), err)
	}
}

func TestTelegraphExtractsOrderedNativeMedia(t *testing.T) {
	body := []byte(`{"ok":true,"result":{"title":"Article","content":["literal text",{"tag":"figure","children":[{"tag":"img","attrs":{"src":"/file/a.jpg"}},{"tag":"img","attrs":{"src":"https://graph.org/file/a.jpg"}},{"tag":"video","attrs":{"src":"/file/b.mp4"}},{"tag":"audio","attrs":{"src":"/file/c.mp3"}},{"tag":"iframe","attrs":{"src":"https://example.test/player"}},{"tag":"img","attrs":{"src":"https://evil.test/file/d.jpg"}}]}]}}`)
	title, media, err := extractTelegraphMedia(body)
	if err != nil || title != "Article" || len(media) != 3 || !strings.HasSuffix(media[1], "/b.mp4") {
		t.Fatalf("title=%q media=%v error=%v", title, media, err)
	}
	for _, raw := range []string{"https://telegra.ph.evil.test/file/a.jpg", "https://telegra.ph:443/file/a.jpg", "https://user@telegra.ph/file/a.jpg", "https://telegra.ph/file/../api", "/file/%2e%2e/api"} {
		if _, ok := telegraphMediaURL(raw); ok {
			t.Fatalf("unsafe media accepted: %s", raw)
		}
	}
	for _, body := range []string{`{"ok":false,"error":"PAGE_NOT_FOUND"}`, `{"ok":true,"result":{"content":[]}}`, `not json`} {
		if _, _, err := extractTelegraphMedia([]byte(body)); err == nil {
			t.Fatalf("invalid page accepted: %s", body)
		}
	}
}

func TestTaskSelectionIncludesOffscreenTasksAndFreezesMembership(t *testing.T) {
	m := &Manager{tasks: map[int64]*Task{}}
	for id := int64(1); id <= 1205; id++ {
		m.orderedIDs = append(m.orderedIDs, id)
		m.tasks[id] = &Task{ID: id, Name: "image", Link: "https://example.test/file", Status: StatusPaused, overviewCategory: "image"}
	}
	selected, err := m.SelectTasks(StatusPaused, "IMAGE", "image")
	if err != nil || len(selected) != 1205 {
		t.Fatalf("selection=%d error=%v", len(selected), err)
	}
	delete(m.tasks, 100)
	m.tasks[1].Status = StatusDone
	if len(selected) != 1205 || selected[0].Status != StatusPaused {
		t.Fatal("selection changed after capture")
	}
	filtered, err := m.SelectTasks(StatusPaused, "image", "image")
	if err != nil || len(filtered) != 1203 {
		t.Fatalf("filtered=%d error=%v", len(filtered), err)
	}
}

func TestGoogleDriveFolderPaginationPreservesResourceKeys(t *testing.T) {
	requests := 0
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		requests++
		if req.URL.Query().Get("resourcekey") != "root-key" {
			t.Error("lost root resource key")
		}
		body := `<title>Root</title><a href="https://drive.google.com/file/d/file-id-1234567890/view?resourcekey=child-key">first.jpg</a><a rel="next" href="?id=root-id-1234567890&amp;page=2">More</a>`
		if req.URL.Query().Get("page") == "2" {
			body = `<a href="https://drive.google.com/file/d/file-id-9876543210/view">second.jpg</a>`
		}
		return googleDriveTestResponse(req, 200, body, http.Header{}), nil
	})}
	_, entries, err := fetchGoogleDriveFolder(context.Background(), client, "root-id-1234567890", googleDriveBaselineProfile, "root-key")
	if err != nil || requests != 2 || len(entries) != 2 || entries[0].Reference.ResourceKey != "child-key" {
		t.Fatalf("requests=%d entries=%v error=%v", requests, entries, err)
	}
	stable := googleDriveBaselineProfile.stableLink(entries[0].Reference.ID, "", "", entries[0].Reference.ResourceKey)
	if !strings.Contains(stable, "resourcekey=child-key") {
		t.Fatalf("lost child key: %s", stable)
	}
}

func TestGoogleDriveFolderRejectsIncompleteAndUnsafePagination(t *testing.T) {
	for _, body := range []string{`<title>Root</title><div data-next-page-token="hidden"></div>`, `<title>Root</title><a rel="next" href="https://evil.test/?id=root-id-1234567890">Next</a>`, `<title>Root</title><a rel="next" href="?id=root-id-1234567890">Next</a>`} {
		client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			return googleDriveTestResponse(req, 200, body, http.Header{}), nil
		})}
		if _, _, err := fetchGoogleDriveFolder(context.Background(), client, "root-id-1234567890", googleDriveBaselineProfile); err == nil {
			t.Fatal("incomplete listing accepted")
		}
	}
}

func TestAriaBatchPauseUsesBoundedMulticallsAndWaitsForWriters(t *testing.T) {
	requests, statusRounds := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		requests++
		var frame struct {
			Method string            `json:"method"`
			Params []json.RawMessage `json:"params"`
		}
		if err := json.NewDecoder(req.Body).Decode(&frame); err != nil {
			t.Error(err)
			return
		}
		if frame.Method != "system.multicall" || len(frame.Params) != 1 {
			t.Error("invalid multicall envelope")
		}
		var calls []struct {
			Method string            `json:"methodName"`
			Params []json.RawMessage `json:"params"`
		}
		if err := json.Unmarshal(frame.Params[0], &calls); err != nil {
			t.Error(err)
			return
		}
		if len(calls) > 128 {
			t.Error("unbounded batch")
		}
		var results []any
		if calls[0].Method == "aria2.tellStatus" {
			statusRounds++
		}
		for _, call := range calls {
			var token, gid string
			_ = json.Unmarshal(call.Params[0], &token)
			_ = json.Unmarshal(call.Params[1], &gid)
			if token != "token:test" {
				t.Error("missing per-call authentication")
			}
			if gid == "missing" {
				results = append(results, map[string]any{"code": 1, "message": "GID missing is not found"})
				continue
			}
			if call.Method == "aria2.pause" {
				results = append(results, []string{gid})
			} else {
				state := "paused"
				if statusRounds == 1 {
					state = "active"
				}
				results = append(results, []ariaStatus{{Status: state}})
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "result": results})
	}))
	defer server.Close()
	client := newAriaClient(0, "test")
	client.url = server.URL
	defer client.http.CloseIdleConnections()
	var targets []rpcTarget
	for id := int64(1); id <= 260; id++ {
		targets = append(targets, rpcTarget{id: id, gid: fmt.Sprint(id)})
	}
	targets = append(targets, rpcTarget{id: 261, gid: "missing"})
	result := client.pauseBatch(targets)
	if len(result) != 1 || !isGIDNotFound(result[261]) || requests > 10 || statusRounds < 2 {
		t.Fatalf("errors=%v requests=%d status rounds=%d", result, requests, statusRounds)
	}
}
