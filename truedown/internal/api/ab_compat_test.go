package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"truedown/internal/downloader"
)

func TestABRequestsPreserveNamesAndInitialState(t *testing.T) {
	for _, tc := range []struct {
		name, path, body, filename string
		status                     downloader.Status
	}{
		{"legacy array", "/add", `[{"link":"https://example.test/file","suggestedName":"legacy.bin","headers":null}]`, "legacy.bin", downloader.StatusQueued},
		{"silent add", "/add", `{"items":[{"type":"http","link":"https://example.test/file","suggestedName":"paused.bin"}],"options":{"silentAdd":true,"silentStart":false}}`, "paused.bin", downloader.StatusPaused},
		{"silent start", "/add", `{"items":[{"type":"http","link":"https://example.test/file","suggestedName":"started.bin"}],"options":{"silentAdd":true,"silentStart":true}}`, "started.bin", downloader.StatusQueued},
		{"typed default", "/start-headless-download", `{"downloadSource":{"type":"http","link":"https://example.test/file","suggestedName":"suggested.bin"},"folder":null,"name":null,"queueId":null,"categoryId":null}`, "suggested.bin", downloader.StatusPaused},
		{"typed start", "/start-headless-download", `{"downloadSource":{"type":"http","link":"https://example.test/file","suggestedName":"suggested.bin"},"name":"explicit.bin","startDownload":true,"startQueue":false}`, "explicit.bin", downloader.StatusQueued},
		{"legacy default", "/start-headless-download", `{"downloadSource":{"link":"https://example.test/file"},"name":"legacy.bin","queueId":0}`, "legacy.bin", downloader.StatusQueued},
		{"legacy explicit pause", "/start-headless-download", `{"downloadSource":{"link":"https://example.test/file"},"name":"paused.bin","startDownload":false}`, "paused.bin", downloader.StatusPaused},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mux, manager := testHandler(t)
			defer manager.Stop()
			request := httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			tasks := manager.ListTasks()
			if len(tasks) != 1 || tasks[0].Name != tc.filename || tasks[0].Status != tc.status {
				t.Fatalf("tasks=%+v", tasks)
			}
		})
	}
}

func TestABUnsupportedRequestsHaveNoSideEffects(t *testing.T) {
	for _, tc := range []struct{ path, body string }{
		{"/start-headless-download", `{"downloadSource":{"type":"hls","link":"https://example.test/stream.m3u8"}}`},
		{"/start-headless-download", `{"downloadSource":{"type":"http","link":"https://example.test/file"},"queueId":1}`},
		{"/start-headless-download", `{"downloadSource":{"type":"http","link":"https://example.test/file"},"categoryId":1}`},
		{"/start-headless-download", `{"downloadSource":{"link":"https://example.test/file"},"startQueue":true}`},
		{"/start-headless-download", `{"downloadSource":{"link":"https://example.test/file"},"startDownload":"false"}`},
		{"/add", `[{"link":"https://example.test/file","unknown":true}]`},
		{"/add", `[{"link":"https://example.test/file"}] {}`},
		{"/add", `{"items":[{"link":"https://example.test/file","type":"http"}],"options":{"unknown":true}}`},
		{"/add", `[null]`},
	} {
		mux, manager := testHandler(t)
		request := httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest || len(manager.ListTasks()) != 0 {
			t.Fatalf("body=%s status=%d tasks=%v", tc.body, response.Code, manager.ListTasks())
		}
		manager.Stop()
	}
}

func TestABQueuesDoesNotInventNamedQueues(t *testing.T) {
	mux, manager := testHandler(t)
	defer manager.Stop()
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/queues", nil))
	if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != "[]" {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	response = httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/queues", nil))
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "GET" {
		t.Fatalf("status=%d", response.Code)
	}
}
