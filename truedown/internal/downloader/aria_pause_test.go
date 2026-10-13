package downloader

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestAriaPauseSettlesBeforeImmediateResume(t *testing.T) {
	for _, queue := range []bool{false, true} {
		name := "task"
		if queue {
			name = "queue"
		}
		t.Run(name, func(t *testing.T) {
			var polls, pauses, resumes atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				var rpc struct{ Method string }
				if err := json.NewDecoder(request.Body).Decode(&rpc); err != nil {
					t.Error(err)
					return
				}
				var result any = "OK"
				switch rpc.Method {
				case "aria2.pause", "aria2.pauseAll":
					pauses.Add(1)
				case "aria2.tellStatus":
					status := "active"
					if polls.Add(1) >= 3 {
						status = "paused"
					}
					result = ariaStatus{Status: status}
				case "aria2.tellActive":
					result = []ariaStatus{{GID: "one"}, {GID: "two"}}
					if polls.Add(1) >= 3 {
						result = []ariaStatus{}
					}
				case "aria2.unpause", "aria2.unpauseAll":
					resumes.Add(1)
					if polls.Load() < 3 {
						t.Error("resume arrived while the engine was still stopping")
					}
				default:
					t.Errorf("unexpected RPC %s", rpc.Method)
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "result": result})
			}))
			defer server.Close()
			client := newAriaClient(0, "secret")
			client.url = server.URL
			defer client.http.CloseIdleConnections()
			pause, resume := func() error { return client.pause("one") }, func() error { return client.unpause("one") }
			if queue {
				pause, resume = client.pauseAll, client.unpauseAll
			}
			if err := pause(); err != nil {
				t.Fatal(err)
			}
			if err := resume(); err != nil {
				t.Fatal(err)
			}
			if pauses.Load() != 1 || resumes.Load() != 1 {
				t.Fatal("pause synchronization repeated a mutation")
			}
		})
	}
}

func TestAriaPauseWaitIsBoundedAndRejectsTerminalState(t *testing.T) {
	for _, status := range []string{"active", "complete", "error", "removed"} {
		t.Run(status, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "result": ariaStatus{Status: status}})
			}))
			defer server.Close()
			client := newAriaClient(0, "secret")
			client.url = server.URL
			defer client.http.CloseIdleConnections()
			ctx, cancel := context.WithTimeout(context.Background(), 75*time.Millisecond)
			defer cancel()
			err := client.waitForPause(ctx, "one")
			if err == nil || (status == "active" && !errors.Is(err, context.DeadlineExceeded)) {
				t.Fatalf("unsettled pause reported success: %v", err)
			}
		})
	}
}

func TestAriaPauseWaitCancelsWithManagerLifecycle(t *testing.T) {
	for _, queue := range []bool{false, true} {
		ctx, cancel := context.WithCancel(context.Background())
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
			var rpc struct{ Method string }
			_ = json.NewDecoder(request.Body).Decode(&rpc)
			if rpc.Method == "aria2.pause" || rpc.Method == "aria2.pauseAll" {
				_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "result": "OK"})
				return
			}
			cancel()
			<-request.Context().Done()
		}))
		client := newAriaClient(0, "secret")
		client.url, client.lifecycleCtx = server.URL, ctx
		var err error
		if queue {
			err = client.pauseAll()
		} else {
			err = client.pause("one")
		}
		cancel()
		client.http.CloseIdleConnections()
		server.Close()
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("shutdown did not cancel pause wait: %v", err)
		}
	}
}
