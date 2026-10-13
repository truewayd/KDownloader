package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"truedown/internal/downloader"
)

func TestProbeRejectsOldEngineAndMalformedRequestsWithoutAdmission(t *testing.T) {
	mux, m := testHandler(t)
	defer m.Stop()
	for _, test := range []struct {
		method, body string
		status       int
	}{
		{"GET", "", 405}, {"POST", `{"link":"https://example.test/file"}`, 409},
		{"POST", `{"link":"magnet:?xt=abc"}`, 400}, {"POST", `{"link":"https://example.test","headers":{"Host":"other"}}`, 400},
		{"POST", `{"link":"https://example.test","opts":{"media":{"protocol":"hls"}}}`, 400},
		{"POST", `{"link":"` + strings.Repeat("x", maxStartRequestBytes) + `"}`, 400},
	} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(test.method, "/tasks/probe", strings.NewReader(test.body))
		request.Header.Set("Content-Type", "application/json")
		mux.ServeHTTP(response, request)
		if response.Code != test.status || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(test.status, response.Code, response.Body.String())
		}
	}
	if len(m.ListTasks()) != 0 {
		t.Fatal("probe rejection admitted a task")
	}
}

func TestNext3ProbeAPIIntegration(t *testing.T) {
	if os.Getenv("TRUEDOWN_INTEGRATION") == "" || os.Getenv("TRUEDOWN_ARIA2_NEXT_VERSION") != "3.0.0" {
		t.Skip("requires NEXT 3")
	}
	root := t.TempDir()
	m, err := downloader.NewManagerWithConfig(os.Getenv("TRUEDOWN_ARIA2_PATH"), filepath.Join(root, "downloads"), filepath.Join(root, "tasks.db"), downloader.ManagerConfig{Aria2Next: true, Aria2NextVersion: "3.0.0"})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	if err = m.Start(); err != nil {
		t.Fatal(err)
	}
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeContent(w, r, "native.bin", time.Unix(1000, 0), bytes.NewReader([]byte("native")))
	}))
	defer source.Close()
	mux := http.NewServeMux()
	Register(mux, m, &testTokenAuth{})
	response := httptest.NewRecorder()
	request := httptest.NewRequest("POST", "/tasks/probe", strings.NewReader(`{"link":"`+source.URL+`/file","opts":{"proxyMode":"none"}}`))
	request.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(response, request)
	var result downloader.ProbeResult
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Status != 206 || result.TotalLength == nil || *result.TotalLength != 6 || !result.Resumable {
		t.Fatal(response.Code, response.Body.String())
	}
	if len(m.ListTasks()) != 0 {
		t.Fatal("probe API admitted a task")
	}
}
