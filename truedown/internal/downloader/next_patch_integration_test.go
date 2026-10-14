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
	"testing"
	"time"
)

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
