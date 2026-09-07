package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"truedown/internal/protocol"
)

func TestCLIRequiresHandshakeBeforeMutation(t *testing.T) {
	t.Setenv("TRUEDOWN_API_TOKEN", "")
	t.Setenv("TRUEDOWN_DATA_DIR", t.TempDir())
	writes := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			writes++
		}
		w.Write([]byte(`{"product":"foreign","protocolVersion":1}`))
	}))
	defer server.Close()
	var out, stderr bytes.Buffer
	code := Run(context.Background(), []string{"--endpoint", server.URL, "pause", "1"}, &out, &stderr)
	if code != 1 || writes != 0 {
		t.Fatalf("code=%d writes=%d", code, writes)
	}
	if strings.Contains(stderr.String(), server.URL) {
		t.Fatal("error exposed request origin")
	}
}

func TestCLICommandsAndPartialFailure(t *testing.T) {
	t.Setenv("TRUEDOWN_API_TOKEN", strings.Repeat("T", 32))
	t.Setenv("TRUEDOWN_DATA_DIR", t.TempDir())
	var added map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Api-Key") != strings.Repeat("T", 32) {
			t.Error("missing authentication")
		}
		switch r.URL.Path {
		case "/system/info":
			json.NewEncoder(w).Encode(protocol.Info{Product: protocol.Product, ProtocolVersion: 1, Version: "dev", Mode: "serve"})
		case "/tasks":
			w.Write([]byte(`{"tasks":[{"id":1,"status":"paused","progress":"50%","name":"evil\u001b[31m\nfile"}],"summary":{"total":1,"paused":1},"total":1}`))
		case "/start-headless-download":
			json.NewDecoder(r.Body).Decode(&added)
			w.Write([]byte("OK 2"))
		case "/tasks/batch":
			w.Write([]byte(`{"succeeded":[1],"failed":[{"id":2,"error":"no such task"}]}`))
		case "/system/exit":
			w.WriteHeader(202)
			w.Write([]byte(`{"accepted":true}`))
		default:
			t.Error(r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	cases := []struct {
		args []string
		code int
		json bool
	}{
		{[]string{"list"}, 0, false},
		{[]string{"--json", "status"}, 0, true},
		{[]string{"--json", "add", "https://example.com/test"}, 0, true},
		{[]string{"--json", "pause", "1", "2"}, 3, true},
		{[]string{"--json", "exit"}, 0, true},
		{[]string{"pause", "-1"}, 2, false},
	}
	for _, test := range cases {
		var out, stderr bytes.Buffer
		args := append([]string{"--endpoint", server.URL}, test.args...)
		code := Run(context.Background(), args, &out, &stderr)
		if code != test.code {
			t.Errorf("%v: code %d stderr %s", test.args, code, &stderr)
		}
		if test.json && !json.Valid(out.Bytes()) {
			t.Errorf("invalid JSON: %q", out.String())
		}
		if !test.json && strings.ContainsRune(out.String(), 27) {
			t.Fatal("terminal escape reached console")
		}
	}
	if added["useDefaults"] != true {
		t.Fatal("CLI did not request server defaults")
	}
}

func TestCLIAuthenticationFailureDoesNotLeakToken(t *testing.T) {
	token := strings.Repeat("private", 8)
	t.Setenv("TRUEDOWN_API_TOKEN", token)
	t.Setenv("TRUEDOWN_DATA_DIR", t.TempDir())
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, token, 401) }))
	defer server.Close()
	var out, stderr bytes.Buffer
	if code := Run(context.Background(), []string{"--endpoint", server.URL, "status"}, &out, &stderr); code != 1 {
		t.Fatal(code)
	}
	if strings.Contains(out.String()+stderr.String(), token) {
		t.Fatal("token exposed")
	}
}
