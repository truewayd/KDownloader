package api

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"truedown/internal/startup"
)

type testStartup struct {
	enabled, fail bool
	writes        int
}

func (s *testStartup) Snapshot() (startup.State, error) {
	return startup.State{Supported: true, Enabled: s.enabled}, nil
}
func (s *testStartup) SetEnabled(enabled bool) (startup.State, error) {
	if s.fail {
		return startup.State{}, errors.New("OS write failed")
	}
	s.enabled = enabled
	s.writes++
	return s.Snapshot()
}

func TestStartupEndpointIsBoundedAndOnlyAcceptsEnabled(t *testing.T) {
	service := &testStartup{}
	mux := http.NewServeMux()
	RegisterStartup(mux, service)
	for _, tc := range []struct {
		method, body string
		status       int
	}{
		{"GET", "", 200},
		{"POST", `{"enabled":true}`, 200},
		{"POST", `{"enabled":false}`, 200},
		{"POST", `{}`, 400},
		{"POST", `{"enabled":null}`, 400},
		{"POST", `{"enabled":true,"path":"C:\\other.exe"}`, 400},
		{"POST", `{"enabled":true} {"enabled":false}`, 400},
		{"POST", `{"enabled":"yes"}`, 400},
		{"DELETE", "", 405},
	} {
		r := httptest.NewRequest(tc.method, "/settings/startup", strings.NewReader(tc.body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("%s %s: status %d, %s", tc.method, tc.body, w.Code, w.Body.String())
		}
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("startup state may be cached")
		}
	}
	if service.writes != 2 {
		t.Fatalf("unexpected writes: %d", service.writes)
	}
	service.fail = true
	w := httptest.NewRecorder()
	request := httptest.NewRequest("POST", "/settings/startup", strings.NewReader(`{"enabled":true}`))
	request.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(w, request)
	if w.Code != http.StatusConflict || service.enabled {
		t.Fatalf("failed save: %d, enabled %v", w.Code, service.enabled)
	}
}
