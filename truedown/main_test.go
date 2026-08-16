package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testAuthState(token string) *authController {
	return &authController{enabled: token != "", token: token}
}

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
	if _, err := validateListenAddress("192.0.2.10:15151", true, true, true); err != nil {
		t.Fatalf("explicit remote address rejected: %v", err)
	}
	if _, err := validateListenAddress("192.0.2.10:15151", true, false, true); err == nil {
		t.Fatal("cleartext remote address unexpectedly allowed")
	}
	if _, err := validateListenAddress("192.0.2.10:15151", true, true, false); err == nil {
		t.Fatal("unauthenticated remote address unexpectedly allowed")
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

func TestBrowserURLUsesTLSWhenConfigured(t *testing.T) {
	if got := browserURLForAddress("192.0.2.10:15151", true); got != "https://192.0.2.10:15151" {
		t.Fatalf("TLS browser URL=%q", got)
	}
}

func TestSecureHandlerRejectsDNSRebindingHost(t *testing.T) {
	token := "0123456789abcdef0123456789abcdef"
	handler := secureHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}), testAuthState(token))
	request := httptest.NewRequest(http.MethodGet, "http://attacker.example:15151/tasks", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("DNS rebinding host response status=%d", response.Code)
	}
}

func TestSecureHandlerRejectsCrossOriginWrites(t *testing.T) {
	token := "0123456789abcdef0123456789abcdef"
	handler := secureHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}), testAuthState(token))

	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:15151/tasks/clear-done", nil)
	request.Header.Set("Origin", "https://attacker.example")
	request.Header.Set("X-Api-Key", token)
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
	extensionRequest.Header.Set("X-Api-Key", token)
	extensionResponse := httptest.NewRecorder()
	handler.ServeHTTP(extensionResponse, extensionRequest)
	if extensionResponse.Code != http.StatusNoContent {
		t.Fatalf("extension response status=%d", extensionResponse.Code)
	}
}

func TestSecureHandlerRequiresTokenAndIssuesDashboardSession(t *testing.T) {
	token := "0123456789abcdef0123456789abcdef"
	handler := secureHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}), testAuthState(token), "127.0.0.1:15151")

	unauthorized := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:15151/tasks?limit=10", nil)
	unauthorizedResponse := httptest.NewRecorder()
	handler.ServeHTTP(unauthorizedResponse, unauthorized)
	if unauthorizedResponse.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status=%d", unauthorizedResponse.Code)
	}

	dashboard := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:15151/", nil)
	dashboard.Header.Set("Sec-Fetch-Mode", "navigate")
	dashboardResponse := httptest.NewRecorder()
	handler.ServeHTTP(dashboardResponse, dashboard)
	if dashboardResponse.Code != http.StatusNoContent {
		t.Fatalf("dashboard status=%d", dashboardResponse.Code)
	}
	if dashboardResponse.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("authenticated dashboard navigation can be served from stale cache")
	}
	result := dashboardResponse.Result()
	if len(result.Cookies()) != 1 || result.Cookies()[0].Name != apiSessionCookie || !result.Cookies()[0].HttpOnly {
		t.Fatalf("dashboard cookies=%+v", result.Cookies())
	}
	crossSiteNavigation := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:15151/", nil)
	crossSiteNavigation.Header.Set("Sec-Fetch-Mode", "navigate")
	crossSiteNavigation.Header.Set("Sec-Fetch-Site", "cross-site")
	crossSiteResponse := httptest.NewRecorder()
	handler.ServeHTTP(crossSiteResponse, crossSiteNavigation)
	if len(crossSiteResponse.Result().Cookies()) != 0 {
		t.Fatalf("cross-site navigation received session cookies: %+v", crossSiteResponse.Result().Cookies())
	}

	authorized := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:15151/tasks?limit=10", nil)
	authorized.AddCookie(result.Cookies()[0])
	authorizedResponse := httptest.NewRecorder()
	handler.ServeHTTP(authorizedResponse, authorized)
	if authorizedResponse.Code != http.StatusNoContent {
		t.Fatalf("cookie-authorized status=%d", authorizedResponse.Code)
	}

	remoteHandler := secureHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}), testAuthState(token), "192.0.2.10:15151")
	remoteDashboard := httptest.NewRequest(http.MethodGet, "https://192.0.2.10:15151/", nil)
	remoteDashboard.Header.Set("Sec-Fetch-Mode", "navigate")
	remoteResponse := httptest.NewRecorder()
	remoteHandler.ServeHTTP(remoteResponse, remoteDashboard)
	if len(remoteResponse.Result().Cookies()) != 0 {
		t.Fatalf("remote dashboard received an automatic API session: %+v", remoteResponse.Result().Cookies())
	}
}

func TestSecureHandlerLeavesTokenAuthenticationOffByDefault(t *testing.T) {
	auth := testAuthState("")
	handler := secureHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}), auth, "127.0.0.1:15151")

	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:15151/tasks?limit=10", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("token-disabled API status=%d", response.Code)
	}

	dashboard := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:15151/", nil)
	dashboard.Header.Set("Sec-Fetch-Mode", "navigate")
	dashboardResponse := httptest.NewRecorder()
	handler.ServeHTTP(dashboardResponse, dashboard)
	if len(dashboardResponse.Result().Cookies()) != 0 {
		t.Fatalf("token-disabled dashboard received an auth cookie: %+v", dashboardResponse.Result().Cookies())
	}

	auth.mu.Lock()
	auth.enabled = true
	auth.token = strings.Repeat("d", 32)
	auth.mu.Unlock()
	newlyProtected := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:15151/tasks?limit=10", nil)
	newlyProtectedResponse := httptest.NewRecorder()
	handler.ServeHTTP(newlyProtectedResponse, newlyProtected)
	if newlyProtectedResponse.Code != http.StatusUnauthorized {
		t.Fatalf("dynamically enabled auth status=%d", newlyProtectedResponse.Code)
	}
	newlyProtected.Header.Set("X-Api-Key", strings.Repeat("d", 32))
	authorizedResponse := httptest.NewRecorder()
	handler.ServeHTTP(authorizedResponse, newlyProtected)
	if authorizedResponse.Code != http.StatusNoContent {
		t.Fatalf("dynamic token status=%d", authorizedResponse.Code)
	}
}

func TestSecureHandlerAcceptsABBrowserIntegrationAPIKey(t *testing.T) {
	token := strings.Repeat("a", 32)
	handler := secureHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}), testAuthState(token), "127.0.0.1:15151")

	unauthorized := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:15151/ping", strings.NewReader("null"))
	unauthorizedResponse := httptest.NewRecorder()
	handler.ServeHTTP(unauthorizedResponse, unauthorized)
	if unauthorizedResponse.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized ping status=%d", unauthorizedResponse.Code)
	}

	authorized := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:15151/add", strings.NewReader(`{"items":[]}`))
	authorized.Header.Set("Origin", "chrome-extension://abcdefghijklmnop")
	authorized.Header.Set("X-Api-Key", token)
	authorizedResponse := httptest.NewRecorder()
	handler.ServeHTTP(authorizedResponse, authorized)
	if authorizedResponse.Code != http.StatusNoContent {
		t.Fatalf("AB API-key status=%d", authorizedResponse.Code)
	}
}

func TestAuthControllerIsOptionalAndPersistsDashboardSetting(t *testing.T) {
	dataDir := t.TempDir()
	controller, err := newAuthController(dataDir, false, "")
	if err != nil {
		t.Fatal(err)
	}
	enabled, token, managed := controller.Snapshot()
	if enabled || token != "" || managed {
		t.Fatalf("default auth enabled=%v token=%q managed=%v", enabled, token, managed)
	}
	token, err = controller.SetEnabled(true)
	if err != nil || len(token) != 64 {
		t.Fatalf("enable token length=%d err=%v", len(token), err)
	}
	reloaded, err := newAuthController(dataDir, false, "")
	if err != nil {
		t.Fatal(err)
	}
	enabled, reloadedToken, managed := reloaded.Snapshot()
	if !enabled || reloadedToken != token || managed {
		t.Fatalf("reloaded auth enabled=%v token match=%v managed=%v", enabled, reloadedToken == token, managed)
	}
	if _, err := reloaded.SetEnabled(false); err != nil {
		t.Fatal(err)
	}
	disabled, _, _ := reloaded.Snapshot()
	if disabled {
		t.Fatal("dashboard setting did not disable token authentication")
	}

	managedController, err := newAuthController(t.TempDir(), false, strings.Repeat("c", 32))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := managedController.SetEnabled(false); err == nil {
		t.Fatal("environment-managed authentication was disabled from the dashboard")
	}
}

func TestAPITokenPersistsAndConfiguredValueIsValidated(t *testing.T) {
	dataDir := t.TempDir()
	first, path, err := loadOrCreateAPIToken(dataDir, "")
	if err != nil {
		t.Fatal(err)
	}
	second, secondPath, err := loadOrCreateAPIToken(dataDir, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 64 || second != first || secondPath != path || !strings.HasSuffix(path, "truedown.token") {
		t.Fatalf("unexpected tokens first=%q second=%q path=%q secondPath=%q", first, second, path, secondPath)
	}
	configured := strings.Repeat("x", 32)
	value, configuredPath, err := loadOrCreateAPIToken(dataDir, configured)
	if err != nil || value != configured || configuredPath != "" {
		t.Fatalf("configured token value=%q path=%q err=%v", value, configuredPath, err)
	}
	if _, _, err := loadOrCreateAPIToken(dataDir, "short"); err == nil {
		t.Fatal("short configured token was accepted")
	}
}
