package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestIndependentCoreCannotRegisterDesktopStartup(t *testing.T) {
	mux := http.NewServeMux()
	RegisterStartup(mux)
	for _, tc := range []struct {
		method, body string
		status       int
	}{
		{"GET", "", 200},
		{"POST", `{"enabled":true}`, 409},
		{"POST", `{"enabled":false}`, 409},
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
		if tc.method == "GET" {
			var state struct {
				Supported, Enabled bool
				Reason             string
			}
			if err := json.Unmarshal(w.Body.Bytes(), &state); err != nil || state.Supported || state.Enabled || state.Reason != startupUnavailable {
				t.Fatalf("unexpected standalone capability: %s, %v", w.Body.String(), err)
			}
		}
	}
}
