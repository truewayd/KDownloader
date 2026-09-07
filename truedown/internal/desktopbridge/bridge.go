// Package desktopbridge adapts the application HTTP handlers to a bounded private
// inherited pipe. It grants no filesystem or process access beyond the public API.
package desktopbridge

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
	"truedown/internal/protocol"
)

type Bridge struct {
	output io.Writer
	mu     sync.Mutex
	owned  bool
}

func New(output io.Writer, owned bool) *Bridge { return &Bridge{output: output, owned: owned} }
func (b *Bridge) Send(response protocol.DesktopResponse) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	return json.NewEncoder(b.output).Encode(response)
}
func (b *Bridge) Serve(ctx context.Context, input io.ReadCloser, handler http.Handler) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = input.Close()
		case <-done:
		}
	}()
	defer close(done)
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), protocol.MaxDesktopRequest+1)
	slots := make(chan struct{}, 32)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	ids := map[uint64]bool{}
	var idsMu sync.Mutex
	for scanner.Scan() {
		var request protocol.DesktopRequest
		decoder := json.NewDecoder(bytes.NewReader(scanner.Bytes()))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&request); err != nil {
			return fmt.Errorf("invalid desktop frame")
		}
		if err := decoder.Decode(&struct{}{}); err != io.EOF {
			return fmt.Errorf("invalid desktop frame")
		}
		if !protocol.AllowedDesktopRequest(request) {
			return fmt.Errorf("unsupported desktop request")
		}
		idsMu.Lock()
		duplicate := ids[request.ID]
		ids[request.ID] = true
		idsMu.Unlock()
		if duplicate {
			return fmt.Errorf("duplicate desktop request ID")
		}
		select {
		case slots <- struct{}{}:
		case <-ctx.Done():
			return ctx.Err()
		}
		workers.Add(1)
		go func(request protocol.DesktopRequest) {
			defer workers.Done()
			defer func() { <-slots; idsMu.Lock(); delete(ids, request.ID); idsMu.Unlock() }()
			requestCtx, cancel := context.WithTimeout(ctx, 6*time.Minute)
			defer cancel()
			response := dispatch(requestCtx, handler, request, b.owned)
			if err := b.Send(response); err != nil {
				_ = input.Close()
			}
		}(request)
	}
	if err := scanner.Err(); err != nil && ctx.Err() == nil {
		return fmt.Errorf("desktop input failed or exceeded its limit")
	}
	return nil
}
func dispatch(ctx context.Context, handler http.Handler, request protocol.DesktopRequest, owned bool) protocol.DesktopResponse {
	response := protocol.DesktopResponse{ID: request.ID, Owned: owned}
	if !owned && request.Path == "/system/exit" {
		response.Status = http.StatusAccepted
		response.Body = `{"accepted":true,"detached":true}`
		return response
	}
	r, err := http.NewRequestWithContext(ctx, request.Method, request.Path, strings.NewReader(request.Body))
	if err != nil {
		response.Error = "invalid desktop request"
		return response
	}
	r.Host = "127.0.0.1"
	r.Header.Set("Content-Type", "application/json")
	for k, v := range request.Headers {
		r.Header.Set(k, v)
	}
	recorder := &boundedResponse{header: make(http.Header), status: http.StatusOK}
	handler.ServeHTTP(recorder, r)
	if recorder.overflow {
		response.Error = "desktop response exceeded its limit"
		return response
	}
	response.Status = recorder.status
	response.Body = recorder.body.String()
	response.Headers = map[string]string{}
	for _, key := range []string{"Content-Type", "ETag", "Retry-After", "X-TrueDown-Duplicate"} {
		if value := recorder.header.Get(key); value != "" {
			response.Headers[key] = value
		}
	}
	return response
}

type boundedResponse struct {
	header   http.Header
	status   int
	body     strings.Builder
	wrote    bool
	overflow bool
}

func (w *boundedResponse) Header() http.Header { return w.header }
func (w *boundedResponse) WriteHeader(status int) {
	if !w.wrote {
		w.status = status
		w.wrote = true
	}
}
func (w *boundedResponse) Write(p []byte) (int, error) {
	if !w.wrote {
		w.WriteHeader(http.StatusOK)
	}
	if w.body.Len()+len(p) > protocol.MaxDesktopResponse {
		w.overflow = true
		return 0, io.ErrShortBuffer
	}
	return w.body.Write(p)
}
