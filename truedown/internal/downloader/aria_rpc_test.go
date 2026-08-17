package downloader

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAriaCallPreservesRPCErrorFromHTTPBadRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"error":{"code":1,"message":"GID 0123456789abcdef is not found"}}`))
	}))
	defer server.Close()

	client := newAriaClient(0, "secret")
	client.url = server.URL

	err := client.call("aria2.tellStatus", []any{"0123456789abcdef"}, nil)
	var rpcErr *ariaRPCError
	if !errors.As(err, &rpcErr) {
		t.Fatalf("call error = %v, want ariaRPCError", err)
	}
	if !isGIDNotFound(err) {
		t.Fatalf("isGIDNotFound(%v) = false", err)
	}
}

func TestAriaCallKeepsGenericHTTPErrorWithoutRPCEnvelope(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "bad request", http.StatusBadRequest)
	}))
	defer server.Close()

	client := newAriaClient(0, "secret")
	client.url = server.URL

	err := client.call("aria2.tellStatus", nil, nil)
	if err == nil || !strings.Contains(err.Error(), "HTTP 400") {
		t.Fatalf("call error = %v, want generic HTTP 400 error", err)
	}
}
