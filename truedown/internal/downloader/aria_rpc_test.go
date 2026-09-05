package downloader

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAriaStatusesIncludesNewestResultsBeyondHistoricalFailures(t *testing.T) {
	stopped := make([]ariaStatus, ariaResultLimit+1)
	for index := range stopped {
		stopped[index] = ariaStatus{GID: fmt.Sprintf("%016x", index+1), Status: "error"}
	}
	stopped[len(stopped)-1].Status = "complete"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, incoming *http.Request) {
		var request struct {
			Method string            `json:"method"`
			Params []json.RawMessage `json:"params"`
		}
		if err := json.NewDecoder(incoming.Body).Decode(&request); err != nil {
			t.Error(err)
			return
		}
		result := []ariaStatus{}
		if request.Method == "aria2.tellStopped" {
			var offset, count int
			if len(request.Params) != 4 || json.Unmarshal(request.Params[1], &offset) != nil ||
				json.Unmarshal(request.Params[2], &count) != nil || count < 1 || count > ariaResultLimit {
				t.Errorf("invalid stopped-result window: %s", request.Params)
				return
			}
			step := 1
			if offset < 0 {
				offset += len(stopped)
				step = -1
			}
			for index := offset; index >= 0 && index < len(stopped) && len(result) < count; index += step {
				result = append(result, stopped[index])
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "result": result})
	}))
	defer server.Close()
	client := newAriaClient(0, "secret")
	client.url = server.URL
	defer client.http.CloseIdleConnections()
	states, err := client.statuses()
	if err != nil {
		t.Fatal(err)
	}
	if len(states) != ariaResultLimit || states[0].GID != stopped[len(stopped)-1].GID || states[0].Status != "complete" {
		t.Fatalf("latest completion was hidden by historical failures: count=%d states=%+v", len(states), states)
	}
}

func TestAriaTrackerResearchRPCUsesNextMethodContract(t *testing.T) {
	requests := make([]map[string]any, 0, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatal(err)
		}
		var payload map[string]any
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatal(err)
		}
		requests = append(requests, payload)
		w.Header().Set("Content-Type", "application/json")
		if payload["method"] == "system.listMethods" {
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":["aria2.tellStatus","aria2.replaceBtTrackers"]}`))
			return
		}
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":2,"result":"0123456789abcdef"}`))
	}))
	defer server.Close()
	client := newAriaClient(0, "secret")
	client.url = server.URL
	supported, err := client.supportsTrackerResearch()
	if err != nil || !supported {
		t.Fatalf("supported=%v err=%v", supported, err)
	}
	trackers := []btTrackerConfig{
		{URL: "http://127.0.0.1:49152/tracker/token", Tier: 0},
		{URL: "udp://tracker.example:80/announce", Tier: 1},
	}
	if err := client.replaceBtTrackers("0123456789abcdef", trackers); err != nil {
		t.Fatal(err)
	}
	if len(requests) != 2 || requests[0]["method"] != "system.listMethods" || requests[1]["method"] != "aria2.replaceBtTrackers" {
		t.Fatalf("requests=%v", requests)
	}
	params, ok := requests[1]["params"].([]any)
	if !ok || len(params) != 3 || params[0] != "token:secret" || params[1] != "0123456789abcdef" {
		t.Fatalf("params=%v", requests[1]["params"])
	}
	entries, ok := params[2].([]any)
	if !ok || len(entries) != 2 {
		t.Fatalf("tracker params=%v", params[2])
	}
	first, ok := entries[0].(map[string]any)
	if !ok || first["url"] != trackers[0].URL || first["tier"] != float64(0) {
		t.Fatalf("first tracker=%v", entries[0])
	}
}

func TestAriaAddTorrentUsesMetainfoRPCContract(t *testing.T) {
	var request map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, incoming *http.Request) {
		if err := json.NewDecoder(incoming.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":"0123456789abcdef"}`))
	}))
	defer server.Close()
	client := newAriaClient(0, "secret")
	client.url = server.URL
	task := &Task{GID: "0123456789abcdef"}
	if err := client.addTorrent(task, "ZDRpbmZvZGU=", map[string]any{"dir": "C:/downloads", "check-integrity": "true"}); err != nil {
		t.Fatal(err)
	}
	if request["method"] != "aria2.addTorrent" {
		t.Fatalf("request=%v", request)
	}
	params, ok := request["params"].([]any)
	if !ok || len(params) != 4 || params[0] != "token:secret" || params[1] != "ZDRpbmZvZGU=" {
		t.Fatalf("params=%v", request["params"])
	}
	webSeeds, ok := params[2].([]any)
	if !ok || len(webSeeds) != 0 {
		t.Fatalf("web seeds=%v", params[2])
	}
	options, ok := params[3].(map[string]any)
	if !ok || options["check-integrity"] != "true" || options["dir"] != "C:/downloads" {
		t.Fatalf("options=%v", params[3])
	}
}

func TestAriaCallPreservesRPCErrorFromHTTPBadRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"error":{"code":1,"message":"GID 0123456789abcdef is not found"}}`))
	}))
	defer server.Close()

	client := newAriaClient(0, "secret")
	client.url = server.URL

	err := client.call("aria2.tellStatus", []any{"0123456789abcdef"}, nil)
	var rpcErr *ariaRPCError
	if !errors.As(err, &rpcErr) {
		t.Fatalf("call error = %v, want ariaRPCError", err)
	}
	if !isGIDNotFound(err) {
		t.Fatalf("isGIDNotFound(%v) = false", err)
	}
}

func TestAriaCallKeepsGenericHTTPErrorWithoutRPCEnvelope(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "bad request", http.StatusBadRequest)
	}))
	defer server.Close()

	client := newAriaClient(0, "secret")
	client.url = server.URL

	err := client.call("aria2.tellStatus", nil, nil)
	if err == nil || !strings.Contains(err.Error(), "HTTP 400") {
		t.Fatalf("call error = %v, want generic HTTP 400 error", err)
	}
}

func TestAriaReadyRejectsImpersonatingEmptyVersionResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}`))
	}))
	defer server.Close()
	client := newAriaClient(0, "secret")
	client.url = server.URL
	if err := client.ready(); err == nil || !strings.Contains(err.Error(), "empty engine version") {
		t.Fatalf("ready error=%v", err)
	}
}

func TestAriaCallRejectsNonObjectEnvelopeWithoutAResultTarget(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("null\n"))
	}))
	defer server.Close()
	client := newAriaClient(0, "secret")
	client.url = server.URL
	if err := client.call("aria2.shutdown", nil, nil); err == nil || !strings.Contains(err.Error(), "JSON object") {
		t.Fatalf("non-object RPC envelope error=%v", err)
	}
}
