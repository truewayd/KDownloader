package desktopbridge

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"truedown/internal/protocol"
)

func TestPrivatePipePreservesStatusETagsAndAttachmentOwnership(t *testing.T) {
	input, writer := io.Pipe()
	reader, output := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var calls atomic.Int32
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("If-None-Match") != "version-1" {
			t.Error("ETag lost")
		}
		w.Header().Set("ETag", "version-1")
		w.WriteHeader(http.StatusNotModified)
	})
	done := make(chan error, 1)
	go func() { done <- New(output, false).Serve(ctx, input, handler); output.Close() }()
	encoder := json.NewEncoder(writer)
	decoder := json.NewDecoder(reader)
	if err := encoder.Encode(protocol.DesktopRequest{ID: 1, Method: "GET", Path: "/tasks?limit=100", Headers: map[string]string{"If-None-Match": "version-1"}}); err != nil {
		t.Fatal(err)
	}
	var response protocol.DesktopResponse
	if err := decoder.Decode(&response); err != nil {
		t.Fatal(err)
	}
	if response.Status != 304 || response.Headers["ETag"] != "version-1" {
		t.Fatalf("%+v", response)
	}
	if err := encoder.Encode(protocol.DesktopRequest{ID: 2, Method: "POST", Path: "/system/exit"}); err != nil {
		t.Fatal(err)
	}
	if err := decoder.Decode(&response); err != nil {
		t.Fatal(err)
	}
	if response.Status != 202 || calls.Load() != 1 || !strings.Contains(response.Body, "detached") {
		t.Fatalf("%+v calls=%d", response, calls.Load())
	}
	writer.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("EOF did not release bridge")
	}
}

func TestPrivatePipeRejectsUnsupportedAccess(t *testing.T) {
	for _, line := range []string{
		`{"id":1,"method":"GET","path":"/../../secret"}`,
		`{"id":1,"method":"GET","path":"http://example.com/tasks"}`,
		`{"id":1,"method":"GET","path":"/tasks","headers":{"X-Api-Key":"secret"}}`,
		`{"id":1,"method":"GET","path":"/tasks","unexpected":true}`,
	} {
		input := io.NopCloser(strings.NewReader(line + "\n"))
		err := New(io.Discard, true).Serve(context.Background(), input, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("unvalidated handler call") }))
		if err == nil {
			t.Errorf("accepted %s", line)
		}
	}
}

func TestPrivatePipeCancelsActiveRequestsOnEOF(t *testing.T) {
	input, writer := io.Pipe()
	var active atomic.Bool
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { active.Store(true); <-r.Context().Done() })
	done := make(chan error, 1)
	go func() { done <- New(io.Discard, true).Serve(context.Background(), input, handler) }()
	_, _ = io.WriteString(writer, `{"id":1,"method":"GET","path":"/tasks"}`+"\n")
	limit := time.After(time.Second)
	for !active.Load() {
		select {
		case <-limit:
			t.Fatal("request not active")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	writer.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("orphaned handler")
	}
}

func TestResponseBound(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		chunk := strings.Repeat("x", 64*1024)
		for i := 0; i < 129; i++ {
			_, _ = io.WriteString(w, chunk)
		}
	})
	response := dispatch(context.Background(), handler, protocol.DesktopRequest{ID: 1, Method: "GET", Path: "/tasks"}, true)
	if response.Error == "" || response.Body != "" {
		t.Fatal("unbounded/partial response exposed")
	}
}
