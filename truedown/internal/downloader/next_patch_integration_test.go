package downloader

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// These fixtures deliberately exercise server behavior corrected in 3.0.3-3.0.7.
// Verify bytes through the manager, not just a successful RPC acknowledgement.
func TestNext308HTTPCompatibilityIntegration(t *testing.T) {
	config := integrationManagerConfig()
	if os.Getenv("TRUEDOWN_INTEGRATION") == "" || !aria2NextVersionAtLeast(config.Aria2NextVersion, 3, 0, 8) {
		t.Skip("requires NEXT 3.0.8 or newer")
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
	var version struct {
		DownloadFeatures []string `json:"downloadFeatures"`
	}
	if err := m.rpc.(*ariaClient).call("aria2.getVersion", nil, &version); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"filename-hints", "filename-resolution"} {
		found := false
		for _, feature := range version.DownloadFeatures {
			found = found || feature == want
		}
		if !found {
			t.Fatalf("restored feature missing: %s", want)
		}
	}
	payload := make([]byte, 4*1024*1024)
	for i := range payload {
		payload[i] = byte((i*31 + i/257) % 251)
	}
	for _, scenario := range []string{"empty", "missing-content-range", "wrong-content-range", "retry-429", "retry-503"} {
		t.Run(scenario, func(t *testing.T) {
			data := payload
			if scenario == "empty" {
				data = nil
			}
			var exercised atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if scenario == "empty" {
					w.Header().Set("Accept-Ranges", "bytes")
					w.Header().Set("Content-Length", "0")
					if r.Header.Get("Range") != "" {
						w.Header().Set("Content-Range", "bytes */0")
						w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
						exercised.Add(1)
					}
					return
				}
				transfer := r.Method == http.MethodGet && r.Header.Get("Range") != "bytes=0-0"
				if transfer && strings.HasPrefix(scenario, "retry-") && exercised.Add(1) == 1 {
					code := http.StatusTooManyRequests
					if scenario == "retry-503" {
						code = http.StatusServiceUnavailable
					}
					w.Header().Set("Retry-After", "1")
					http.Error(w, "fixture host busy", code)
					return
				}
				recorder := httptest.NewRecorder()
				http.ServeContent(recorder, r, "data.bin", time.Unix(1700000000, 0), bytes.NewReader(data))
				if transfer && recorder.Code == http.StatusPartialContent {
					switch scenario {
					case "missing-content-range":
						recorder.Header().Del("Content-Range")
						exercised.Add(1)
					case "wrong-content-range":
						recorder.Header().Set("Content-Range", "bytes 1-1/"+strconv.Itoa(len(data)))
						exercised.Add(1)
					}
				}
				for key, values := range recorder.Header() {
					w.Header()[key] = values
				}
				w.WriteHeader(recorder.Code)
				_, _ = w.Write(recorder.Body.Bytes())
			}))
			defer server.Close()
			opts := Aria2Opts{Connections: 2, MaxTries: 3, RetryWait: 1, ProxyMode: "none", ExtraArgs: []string{"--min-split-size=1M"}}
			task, _, err := m.AddTask(server.URL+"/data.bin", scenario+".bin", "", nil, "", 0, opts)
			if err != nil {
				t.Fatal(err)
			}
			waitForStatus(t, m, task.ID, 20*time.Second, StatusDone)
			assertTransferHash(t, filepath.Join(task.Folder, task.OutputName), data)
			if exercised.Load() == 0 {
				t.Fatal("fixture did not exercise the intended server response")
			}
		})
	}
}

func TestManagedEngineIgnoresAmbientConfigIntegration(t *testing.T) {
	if os.Getenv("TRUEDOWN_INTEGRATION") == "" {
		t.Skip("requires a real integration engine")
	}
	engine, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	for _, name := range []string{"HOME", "USERPROFILE", "XDG_CONFIG_HOME"} {
		t.Setenv(name, root)
	}
	for _, directory := range []string{"aria2", ".aria2", "AppData/Local/aria2", "AppData/Local/aria2-next", "AppData/Roaming/aria2"} {
		path := filepath.Join(root, directory)
		if err := os.MkdirAll(path, 0700); err != nil {
			t.Fatal(err)
		}
		// An unrelated CLI configuration must not detach or reconfigure our child.
		if err := os.WriteFile(filepath.Join(path, "aria2.conf"), []byte("daemon\ncheck-certificate=false\ninvalid-ambient-option=true\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	m, err := NewManagerWithConfig(engine, filepath.Join(root, "downloads"), filepath.Join(root, "records.db"), integrationManagerConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	requireAriaGlobalOption(t, m, "check-certificate", "true")
	if states, err := m.rpc.statuses(); err != nil || len(states) != 0 {
		t.Fatalf("ambient config admitted tasks: %v %v", states, err)
	}
	select {
	case err := <-m.cmdDone:
		t.Fatalf("managed engine detached: %v", err)
	default:
	}
}

func TestNext3CompressedHTTPIntegration(t *testing.T) {
	config := integrationManagerConfig()
	if os.Getenv("TRUEDOWN_INTEGRATION") == "" || !aria2NextVersionAtLeast(config.Aria2NextVersion, 3, 0, 1) {
		t.Skip("requires NEXT 3.0.1 or newer gzip defaults")
	}
	engine, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	payload := bytes.Repeat([]byte("decoded HTTP response\n"), 4096)
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
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
	requireAriaGlobalOption(t, m, "http-accept-gzip", "true")
	for _, scenario := range []string{"negotiated", "unsolicited", "archive"} {
		t.Run(scenario, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if scenario == "negotiated" && r.Header.Get("Range") == "" && !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
					t.Error("native HTTP request did not negotiate gzip")
					w.WriteHeader(http.StatusNotAcceptable)
					return
				}
				if scenario == "archive" {
					w.Header().Set("Content-Type", "application/gzip")
				} else {
					w.Header().Set("Content-Type", "application/octet-stream")
					w.Header().Set("Content-Encoding", "gzip")
				}
				w.Header().Set("Content-Length", strconv.Itoa(compressed.Len()))
				_, _ = w.Write(compressed.Bytes())
			}))
			defer server.Close()
			opts := Aria2Opts{Connections: 1, ProxyMode: "none"}
			task, _, err := m.AddTask(server.URL+"/file", fmt.Sprintf("%s.bin", scenario), "", nil, "", 0, opts)
			if err != nil {
				t.Fatal(err)
			}
			waitForStatus(t, m, task.ID, 10*time.Second, StatusDone)
			actual, err := os.ReadFile(filepath.Join(task.Folder, task.OutputName))
			if err != nil {
				t.Fatal(err)
			}
			want := payload
			if scenario == "archive" {
				want = compressed.Bytes()
			}
			if !bytes.Equal(actual, want) {
				t.Fatalf("downloaded %d bytes, expected %d matching bytes", len(actual), len(want))
			}
		})
	}
}
