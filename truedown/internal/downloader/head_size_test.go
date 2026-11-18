package downloader

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestOptionalHTTPSizeProbeRunsAfterAdmission(t *testing.T) {
	for _, test := range []struct {
		name    string
		enabled bool
		status  int
		length  int64
		hint    int64
	}{
		{"disabled", false, http.StatusOK, 0, 0},
		{"unknown transfer size", true, http.StatusOK, 0, 512},
		{"transfer provides size first", true, http.StatusOK, 1024, 0},
		{"HEAD rejected", true, http.StatusMethodNotAllowed, 0, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			var requests atomic.Int32
			started := make(chan struct{})
			release := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if requests.Add(1) == 1 {
					close(started)
				}
				select {
				case <-release:
				case <-r.Context().Done():
					return
				}
				if r.Method != http.MethodHead || r.Header.Get("Accept-Encoding") != "identity" || r.Header.Get("Range") != "" {
					t.Error("unexpected probe request", r.Method, r.Header)
				}
				w.Header().Set("Content-Length", "512")
				w.WriteHeader(test.status)
			}))
			defer server.Close()
			unblock := sync.OnceFunc(func() { close(release) })
			defer unblock()
			m, _ := transferTestManager(t)
			defaults := m.TaskDefaults()
			defaults.Values.UseHead = test.enabled
			if _, err := m.SetTaskDefaults(defaults.Revision, defaults.Values); err != nil {
				t.Fatal(err)
			}
			task, _, err := m.AddTask(server.URL+"/file.bin", "", "", map[string]string{"Range": "bytes=0-1"}, "", 0, Aria2Opts{})
			if err != nil {
				t.Fatal(err)
			}
			m.flushAdmissions(false)
			submitted := make(chan bool, 1)
			go func() { submitted <- m.submit(submission{id: task.ID}) }()
			select {
			case ok := <-submitted:
				if !ok {
					t.Fatal("task did not reach the transfer engine")
				}
			case <-time.After(2 * time.Second):
				t.Fatal("engine admission waited for the HEAD response")
			}
			if test.enabled {
				select {
				case <-started:
				case <-time.After(2 * time.Second):
					t.Fatal("background HEAD did not start")
				}
			}
			if test.length > 0 {
				if err := m.setTask(task.ID, func(t *Task) { t.TotalLength = test.length }); err != nil {
					t.Fatal(err)
				}
			}
			unblock()
			deadline := time.Now().Add(2 * time.Second)
			for m.headReads.Load() != 0 && time.Now().Before(deadline) {
				time.Sleep(5 * time.Millisecond)
			}
			if m.headReads.Load() != 0 {
				t.Fatal("background HEAD did not settle")
			}
			got := m.PageTaskSnapshots(0, 1, "", "").Tasks[0]
			if got.TotalLength != test.length || got.SizeHint != test.hint || (requests.Load() == 1) != test.enabled {
				t.Fatalf("got length %d, hint %d and %d probe requests", got.TotalLength, got.SizeHint, requests.Load())
			}
		})
	}
}
