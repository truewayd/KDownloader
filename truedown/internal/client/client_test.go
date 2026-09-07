package client

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"truedown/internal/protocol"
)

func TestHandshakeAndCredentialBoundary(t *testing.T) {
	token := strings.Repeat("K", 32)
	destinationCalls := 0
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { destinationCalls++ }))
	defer destination.Close()
	redirect := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Api-Key") != token {
			t.Error("missing exact API credential")
		}
		if redirect {
			http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
			return
		}
		json.NewEncoder(w).Encode(protocol.Info{Product: protocol.Product, ProtocolVersion: protocol.Version})
	}))
	defer server.Close()
	c, err := New(server.URL, token)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Handshake(context.Background()); err != nil {
		t.Fatal(err)
	}
	redirect = true
	if _, err := c.Handshake(context.Background()); err == nil {
		t.Fatal("redirect accepted")
	}
	if destinationCalls != 0 {
		t.Fatal("credentials reached redirected destination")
	}
}

func TestRejectWrongProtocolAndOversizedResponses(t *testing.T) {
	oversized := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if oversized {
			w.Write([]byte(strings.Repeat("x", MaxResponseBytes+1)))
			return
		}
		w.Write([]byte(`{"product":"AnotherDownloader","protocolVersion":1}`))
	}))
	defer server.Close()
	c, err := New(server.URL, "")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Handshake(context.Background()); err == nil {
		t.Fatal("foreign endpoint accepted")
	}
	oversized = true
	if _, err := c.Request(context.Background(), "GET", "/tasks", nil); err == nil {
		t.Fatal("oversized response accepted")
	}
}

func TestEndpointValidation(t *testing.T) {
	for _, endpoint := range []string{"http://example.com", "https://example.com", "file:///x", "http://user:password@127.0.0.1", "http://127.0.0.1/path", "http://127.0.0.1:99999", "http://127.0.0.1?x=1", "http://127.0.0.1#fragment"} {
		if _, err := New(endpoint, ""); err == nil {
			t.Errorf("accepted %s", endpoint)
		}
	}
	if _, err := New("http://127.0.0.1", strings.Repeat("x", 32)+"\n"); err == nil {
		t.Fatal("invalid token accepted")
	}
}
