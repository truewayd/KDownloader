package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestValidateListenAddressDefaultsToLoopback(t *testing.T) {
	addr, err := validateListenAddress("", false)
	if err != nil {
		t.Fatal(err)
	}
	if addr != "127.0.0.1:15151" {
		t.Fatalf("default address is %q", addr)
	}
}

func TestValidateListenAddressRequiresExplicitRemoteOptIn(t *testing.T) {
	for _, addr := range []string{":15151", "0.0.0.0:15151", "192.0.2.10:15151"} {
		if _, err := validateListenAddress(addr, false); err == nil {
			t.Fatalf("address %q unexpectedly allowed", addr)
		}
	}
	if _, err := validateListenAddress("192.0.2.10:15151", true); err != nil {
		t.Fatalf("explicit remote address rejected: %v", err)
	}
	if _, err := validateListenAddress("0.0.0.0:15151", true); err == nil {
		t.Fatal("wildcard remote address unexpectedly allowed")
	}
	if _, err := validateListenAddress("remote.example:15151", true); err == nil {
		t.Fatal("hostname remote address unexpectedly allowed")
	}
	if _, err := validateListenAddress(":15151", true); err == nil {
		t.Fatal("empty remote address unexpectedly allowed")
	}
}

func TestSecureHandlerRejectsDNSRebindingHost(t *testing.T) {
	handler := secureHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	request := httptest.NewRequest(http.MethodGet, "http://attacker.example:15151/tasks", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("DNS rebinding host response status=%d", response.Code)
	}
}

func TestSecureHandlerRejectsCrossOriginWrites(t *testing.T) {
	handler := secureHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:15151/tasks/clear-done", nil)
	request.Header.Set("Origin", "https://attacker.example")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("cross-origin response status=%d", response.Code)
	}
	if response.Header().Get("Content-Security-Policy") == "" {
		t.Fatal("security headers were not applied")
	}

	extensionRequest := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:15151/tasks/clear-done", nil)
	extensionRequest.Header.Set("Origin", "chrome-extension://abcdefghijklmnop")
	extensionResponse := httptest.NewRecorder()
	handler.ServeHTTP(extensionResponse, extensionRequest)
	if extensionResponse.Code != http.StatusNoContent {
		t.Fatalf("extension response status=%d", extensionResponse.Code)
	}
}
