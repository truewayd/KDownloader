package app

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"truedown/internal/profile"
	"truedown/internal/protocol"
)

func TestDesktopAttachmentRequiresCompleteBoundedResponses(t *testing.T) {
	t.Setenv("TRUEDOWN_API_TOKEN", "")
	location, err := profile.Resolve(t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name       string
		body       string
		length     int
		status     int
		wantStatus int
	}{
		{name: "complete", body: "OK 123456", length: 9, status: http.StatusCreated, wantStatus: http.StatusCreated},
		{name: "truncated task ID", body: "OK 123", length: 9, status: http.StatusCreated, wantStatus: http.StatusBadGateway},
		{name: "oversized", body: strings.Repeat("x", protocol.MaxDesktopResponse+1), length: protocol.MaxDesktopResponse + 1, status: http.StatusOK, wantStatus: http.StatusBadGateway},
	} {
		t.Run(test.name, func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/system/info":
					_ = json.NewEncoder(w).Encode(protocol.Info{Product: protocol.Product, ProtocolVersion: protocol.Version})
				case "/system/storage":
					_ = json.NewEncoder(w).Encode(location)
				case "/start-headless-download":
					requests.Add(1)
					w.Header().Set("Content-Type", "text/plain")
					w.Header().Set("Content-Length", strconv.Itoa(test.length))
					w.Header().Set("ETag", "accepted-task")
					w.Header().Set("X-TrueDown-Duplicate", "true")
					w.Header().Set("Set-Cookie", "private-credential")
					w.WriteHeader(test.status)
					_, _ = io.WriteString(w, test.body)
				default:
					t.Errorf("unexpected request: %s", r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer server.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			handler, err := existingDesktopHandler(ctx, server.URL, location)
			if err != nil {
				t.Fatal(err)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/start-headless-download", strings.NewReader(`{}`)))
			if requests.Load() != 1 {
				t.Fatal("replayed an uncertain core request")
			}
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d", response.Code, test.wantStatus)
			}
			if response.Header().Get("Set-Cookie") != "" {
				t.Fatal("forwarded a credential-bearing header")
			}
			if test.wantStatus == http.StatusBadGateway {
				if response.Header().Get("ETag") != "" || response.Header().Get("X-TrueDown-Duplicate") != "" {
					t.Fatal("failed response retained success metadata")
				}
				if response.Body.Len() > 1024 || strings.Contains(response.Body.String(), "123") {
					t.Fatal("failed response exposed a partial body")
				}
			} else if response.Body.String() != test.body || response.Header().Get("ETag") != "accepted-task" || response.Header().Get("X-TrueDown-Duplicate") != "true" {
				t.Fatal("complete response lost its status, body or allowed headers")
			}
		})
	}
}
