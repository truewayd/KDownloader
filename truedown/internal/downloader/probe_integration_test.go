package downloader

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestNext3ProbeIntegration(t *testing.T) {
	config := integrationManagerConfig()
	if os.Getenv("TRUEDOWN_INTEGRATION") == "" || !aria2NextVersionAtLeast(config.Aria2NextVersion, 3, 0, 0) {
		t.Skip("requires NEXT 3")
	}
	engine, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	m, err := NewManagerWithConfig(engine, filepath.Join(root, "downloads"), filepath.Join(root, "records.db"), config)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	if !m.EngineCapabilities().Probe {
		t.Fatal("released engine did not advertise probe")
	}
	var leaked, authenticated, oneByte atomic.Bool
	child := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
			leaked.Store(true)
		}
		http.ServeContent(w, r, "child.bin", time.Unix(1000, 0), bytes.NewReader([]byte("child")))
	}))
	defer child.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/redirect":
			http.Redirect(w, r, child.URL+"/child", http.StatusFound)
		case "/same":
			http.Redirect(w, r, "/file", http.StatusFound)
		case "/file":
			authenticated.Store(r.Header.Get("Cookie") == "private" && r.Header.Get("Authorization") == "Bearer private")
			oneByte.Store(r.Header.Get("Range") == "bytes=0-0")
			w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95.bin")
			http.ServeContent(w, r, "file.bin", time.Unix(1000, 0), bytes.NewReader(bytes.Repeat([]byte("data"), 1024)))
		case "/empty":
			w.Header().Set("Content-Length", "0")
			w.WriteHeader(200)
		case "/no-range":
			w.Header().Set("Content-Length", "4")
			_, _ = w.Write([]byte("data"))
		case "/unknown":
			w.WriteHeader(200)
			w.(http.Flusher).Flush()
			_, _ = w.Write([]byte("data"))
		default:
			http.Error(w, "not found", 404)
		}
	}))
	defer source.Close()
	for _, scenario := range []struct {
		path      string
		status    int
		size      int64
		resumable bool
	}{
		{"/file", 206, 4096, true}, {"/same", 206, 4096, true}, {"/redirect", 206, 5, true}, {"/empty", 200, 0, false}, {"/no-range", 200, 4, false}, {"/unknown", 200, -1, false}, {"/missing", 404, -1, false},
	} {
		t.Run(scenario.path, func(t *testing.T) {
			result, err := m.ProbeLink(context.Background(), source.URL+scenario.path, map[string]string{"Cookie": "private", "Authorization": "Bearer private"}, "", Aria2Opts{ProxyMode: "none"})
			if err != nil {
				t.Fatal(err)
			}
			if result.Status != scenario.status || result.Resumable != scenario.resumable || (scenario.size < 0 && result.TotalLength != nil) || (scenario.size >= 0 && (result.TotalLength == nil || *result.TotalLength != scenario.size)) {
				t.Fatalf("incorrect native metadata: %+v", result)
			}
			if scenario.path == "/file" && (result.Filename != "测试.bin" || !authenticated.Load() || !oneByte.Load()) {
				t.Fatal("probe lost native naming/range/auth", result)
			}
			if scenario.path == "/same" && !authenticated.Load() {
				t.Fatal("same origin lost credentials")
			}
			if scenario.path == "/redirect" && (leaked.Load() || result.FinalURL != child.URL+"/child") {
				t.Fatal("redirect lost final URL or exposed credentials")
			}
		})
	}
	if len(m.ListTasks()) != 0 {
		t.Fatal("probe admitted a download")
	}
	entries, err := os.ReadDir(m.defaultDir)
	if err != nil || len(entries) != 0 {
		t.Fatal("probe wrote download files", entries, err)
	}
	for _, method := range []string{"aria2.tellActive", "aria2.tellWaiting", "aria2.tellStopped"} {
		var states []ariaStatus
		var params []any
		if method != "aria2.tellActive" {
			params = []any{0, 100}
		}
		if err := m.rpc.(*ariaClient).call(method, params, &states); err != nil || len(states) != 0 {
			t.Fatal("probe created native task state", method, states, err)
		}
	}
}
