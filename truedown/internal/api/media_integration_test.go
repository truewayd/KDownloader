package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
	"truedown/internal/downloader"
)

func next3IntegrationConfig(t *testing.T) downloader.ManagerConfig {
	t.Helper()
	version := os.Getenv("TRUEDOWN_ARIA2_NEXT_VERSION")
	parts := strings.Split(version, ".")
	major, err := strconv.Atoi(parts[0])
	if os.Getenv("TRUEDOWN_INTEGRATION") == "" || len(parts) != 3 || err != nil || major < 3 {
		t.Skip("requires NEXT 3 or newer")
	}
	return downloader.ManagerConfig{Aria2Next: true, Aria2NextVersion: version}
}

func TestLegacyEngineAcceptsMixedBrowserTasksWithoutDroppingMedia(t *testing.T) {
	mux, m := testHandler(t)
	defer m.Stop()
	body := `{"items":[{"type":"http","link":"https://example.test/file.zip"},{"type":"hls","link":"https://example.test/index.m3u8"}],"options":{"silentAdd":true}}`
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest("POST", "/add", strings.NewReader(body)))
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	deadline := time.Now().Add(3 * time.Second)
	for len(m.ListTasks()) < 2 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if len(m.ListTasks()) != 2 {
		t.Fatal("mixed batch lost a task")
	}
	for _, task := range m.ListTasks() {
		if task.Status != downloader.StatusPaused {
			t.Fatal("silent add started a task", task.Status)
		}
		details, err := m.TaskDetails(task.ID)
		if err != nil {
			t.Fatal(err)
		}
		if details.RequiresMediaEngine != (task.Opts.Media != nil) {
			t.Fatal("incorrect blocked capability state", details)
		}
	}
	issues := m.DownloadIssues()
	if issues.EngineRequired != 1 || issues.Downloads != 0 {
		t.Fatal(issues)
	}
}

func TestNext3MediaBrowserAdmissionIntegration(t *testing.T) {
	config := next3IntegrationConfig(t)
	root := t.TempDir()
	m, err := downloader.NewManagerWithConfig(os.Getenv("TRUEDOWN_ARIA2_PATH"), filepath.Join(root, "downloads"), filepath.Join(root, "records.db"), config)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	if err = m.Start(); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	Register(mux, m, &testTokenAuth{})
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest("GET", "/engine/capabilities", nil))
	var caps downloader.EngineCapabilities
	if json.Unmarshal(response.Body.Bytes(), &caps) != nil || !caps.Media {
		t.Fatal(response.Body.String())
	}
	for _, request := range []struct{ path, body string }{
		{"/add", `{"items":[{"type":"hls","link":"https://example.invalid/one.m3u8","suggestedName":"Browser"}],"options":{"silentAdd":true}}`},
		{"/start-headless-download", `{"downloadSource":{"type":"hls","link":"https://example.invalid/two.m3u8","suggestedName":"Headless"}}`},
	} {
		response := httptest.NewRecorder()
		incoming := httptest.NewRequest("POST", request.path, strings.NewReader(request.body))
		incoming.Header.Set("Content-Type", "application/json")
		mux.ServeHTTP(response, incoming)
		if response.Code != 200 {
			t.Fatalf("%s: %d %s", request.path, response.Code, response.Body.String())
		}
	}
	deadline := time.Now().Add(3 * time.Second)
	for len(m.ListTasks()) < 2 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	tasks := m.ListTasks()
	if len(tasks) != 2 {
		t.Fatal("browser import not admitted")
	}
	for _, task := range tasks {
		if task.Opts.Media == nil || task.Opts.Media.Protocol != "hls" || task.Status != downloader.StatusPaused {
			t.Fatalf("typed media lost pause/protocol: %+v", task)
		}
	}
}
