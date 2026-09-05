package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"truedown/internal/api"
	"truedown/internal/downloader"
)

func TestBundledStableAria2MatchesReviewedOfficialBuild(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("aria2", "aria2c.exe"))
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	const expected = "be2099c214f63a3cb4954b09a0becd6e2e34660b886d4c898d260febfe9d70c2"
	if actual := hex.EncodeToString(digest[:]); actual != expected {
		t.Fatalf("bundled aria2c.exe SHA-256=%s, want reviewed official build %s", actual, expected)
	}
}

func testAuthState(token string) *authController {
	return &authController{enabled: token != "", token: token}
}

type toggleTestAuth struct {
	enabled bool
	token   string
}

func (auth *toggleTestAuth) Snapshot() (bool, string, bool) {
	return auth.enabled, auth.token, false
}

func (auth *toggleTestAuth) SetEnabled(enabled bool) (string, error) {
	auth.enabled = enabled
	return auth.token, nil
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

func TestSecureHandlerRequiresExactWriteOrigin(t *testing.T) {
	for _, test := range []struct {
		name, target, origin string
		want                 int
	}{
		{"same HTTP origin", "http://127.0.0.1:15151/tasks/clear-done", "http://127.0.0.1:15151", http.StatusNoContent},
		{"same HTTPS origin", "https://127.0.0.1:15151/tasks/clear-done", "https://127.0.0.1:15151", http.StatusNoContent},
		{"HTTP origin on TLS", "https://127.0.0.1:15151/tasks/clear-done", "http://127.0.0.1:15151", http.StatusForbidden},
		{"HTTPS origin on cleartext", "http://127.0.0.1:15151/tasks/clear-done", "https://127.0.0.1:15151", http.StatusForbidden},
		{"userinfo", "http://127.0.0.1:15151/tasks/clear-done", "http://user@127.0.0.1:15151", http.StatusForbidden},
		{"path", "http://127.0.0.1:15151/tasks/clear-done", "http://127.0.0.1:15151/path", http.StatusForbidden},
		{"extension", "http://127.0.0.1:15151/tasks/clear-done", "chrome-extension://abcdefghijklmnop", http.StatusNoContent},
	} {
		t.Run(test.name, func(t *testing.T) {
			handler := secureHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusNoContent)
			}), testAuthState(""), "127.0.0.1:15151")
			request := httptest.NewRequest(http.MethodPost, test.target, nil)
			request.Header.Set("Origin", test.origin)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.want {
				t.Fatalf("status=%d, want %d", response.Code, test.want)
			}
		})
	}
}

func TestSecureHandlerRequiresTokenAndIssuesDashboardSession(t *testing.T) {
	token := strings.Repeat("x", 30) + ";,"
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
	if result.Cookies()[0].Value != apiSessionCookieValue(token) || result.Cookies()[0].Value == token {
		t.Fatalf("dashboard token was not encoded into a cookie-safe value: %q", result.Cookies()[0].Value)
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
	staleHeader := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:15151/tasks?limit=10", nil)
	staleHeader.Header.Set("X-Api-Key", strings.Repeat("z", 32))
	staleHeader.AddCookie(result.Cookies()[0])
	staleHeaderResponse := httptest.NewRecorder()
	handler.ServeHTTP(staleHeaderResponse, staleHeader)
	if staleHeaderResponse.Code != http.StatusNoContent {
		t.Fatalf("fresh dashboard cookie did not override stale session header: status=%d", staleHeaderResponse.Code)
	}
	headerAuthorized := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:15151/tasks?limit=10", nil)
	headerAuthorized.Header.Set("X-Api-Key", token)
	headerResponse := httptest.NewRecorder()
	handler.ServeHTTP(headerResponse, headerAuthorized)
	if headerResponse.Code != http.StatusNoContent {
		t.Fatalf("printable-ASCII header-authorized status=%d", headerResponse.Code)
	}
	paddedHeader := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:15151/tasks?limit=10", nil)
	paddedHeader.Header.Set("X-Api-Key", " "+token+" ")
	paddedResponse := httptest.NewRecorder()
	handler.ServeHTTP(paddedResponse, paddedHeader)
	if paddedResponse.Code != http.StatusUnauthorized {
		t.Fatalf("padded API Key header status=%d", paddedResponse.Code)
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

func TestAuthSettingsCookieAuthenticatesPrintableASCIIToken(t *testing.T) {
	root := t.TempDir()
	manager, err := downloader.NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Stop()
	token := strings.Repeat("x", 28) + ";,\"\\"
	if err := validateAPIToken(token); err != nil {
		t.Fatal(err)
	}
	auth := &toggleTestAuth{token: token}
	mux := http.NewServeMux()
	api.Register(mux, manager, auth)
	handler := secureHandler(mux, auth, "127.0.0.1:15151")

	enable := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:15151/auth/settings", strings.NewReader(`{"enabled":true}`))
	enable.Header.Set("Content-Type", "application/json")
	enableResponse := httptest.NewRecorder()
	handler.ServeHTTP(enableResponse, enable)
	if enableResponse.Code != http.StatusOK {
		t.Fatalf("enable auth status=%d body=%s", enableResponse.Code, enableResponse.Body.String())
	}
	cookies := enableResponse.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Value != api.SessionCookieValue(token) || cookies[0].Value == token {
		t.Fatalf("enable auth cookies=%+v", cookies)
	}

	tasks := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:15151/tasks?limit=1", nil)
	tasks.AddCookie(cookies[0])
	tasksResponse := httptest.NewRecorder()
	handler.ServeHTTP(tasksResponse, tasks)
	if tasksResponse.Code != http.StatusOK {
		t.Fatalf("cookie-authenticated tasks status=%d body=%s", tasksResponse.Code, tasksResponse.Body.String())
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

func TestSecureHandlerProtectsDownloadRuleSyncWithAPIKey(t *testing.T) {
	token := strings.Repeat("f", 32)
	handler := secureHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}), testAuthState(token), "127.0.0.1:15151")

	unauthorized := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:15151/settings/download-rules", strings.NewReader(`{"enabled":true}`))
	unauthorized.Header.Set("Origin", "chrome-extension://abcdefghijklmnop")
	unauthorizedResponse := httptest.NewRecorder()
	handler.ServeHTTP(unauthorizedResponse, unauthorized)
	if unauthorizedResponse.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized rule sync status=%d", unauthorizedResponse.Code)
	}

	authorized := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:15151/settings/download-rules", strings.NewReader(`{"enabled":true}`))
	authorized.Header.Set("Origin", "chrome-extension://abcdefghijklmnop")
	authorized.Header.Set("X-Api-Key", token)
	authorizedResponse := httptest.NewRecorder()
	handler.ServeHTTP(authorizedResponse, authorized)
	if authorizedResponse.Code != http.StatusNoContent {
		t.Fatalf("authorized rule sync status=%d", authorizedResponse.Code)
	}
}

func TestBuildScriptGuardsRecursiveDeleteAndCopiesAgainstReparsePoints(t *testing.T) {
	data, err := os.ReadFile("build.ps1")
	if err != nil {
		t.Fatal(err)
	}
	script := string(data)
	quarantine := strings.Index(script, "[System.IO.Directory]::Move($fullPath, $quarantine)")
	guard := strings.Index(script, "Assert-NoReparseTree $quarantine")
	remove := strings.Index(script, "Remove-Item -LiteralPath $quarantine -Recurse -Force")
	if quarantine < 0 || guard < quarantine || remove < guard {
		t.Fatal("recursive build cleanup is not quarantined and revalidated before removal")
	}
	if !strings.Contains(script, "Assert-RegularSourceFile -Root $projectRoot -Path $entry.Source") ||
		!strings.Contains(script, "[System.IO.File]::Copy") ||
		!strings.Contains(script, "Assert-NoReparsePath -Root $projectRoot -Path $dist") ||
		!strings.Contains(script, "Assert-BuildInputs -Root $projectRoot") ||
		!strings.Contains(script, "-H windowsgui") ||
		!strings.Contains(script, "Assert-WindowsGUISubsystem -Executable $exe") ||
		!strings.Contains(script, "Assert-ExecutableIcon -Executable $exe -ExpectedIcon $icon") ||
		!strings.Contains(script, "Assert-ExecutableDPIManifest -Executable $exe -ExpectedManifest $appManifest") ||
		!strings.Contains(script, "Assert-TrayIconResource -Executable $exe") {
		t.Fatal("build input/output paths are not constrained against reparse traversal")
	}
	if strings.Contains(script, "$paths = @($current)") {
		t.Fatal("build script must trust the repository root while checking descendants")
	}
}

func TestWindowsManifestDeclaresPerMonitorV2DPI(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("windows", "truedown.manifest"))
	if err != nil {
		t.Fatal(err)
	}
	manifest := string(data)
	for _, declaration := range []string{
		`<dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>`,
		`<dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2, PerMonitor</dpiAwareness>`,
	} {
		if !strings.Contains(manifest, declaration) {
			t.Fatalf("Windows manifest is missing %s", declaration)
		}
	}
	generator, err := os.ReadFile(filepath.Join("windows", "generate_icon.ps1"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(generator), "-manifest $manifest") {
		t.Fatal("Windows resource generator does not embed the DPI manifest")
	}
}

func TestWindowsIconContainsShellSizes(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("windows", "truedown.ico"))
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 6 || binary.LittleEndian.Uint16(data[0:2]) != 0 || binary.LittleEndian.Uint16(data[2:4]) != 1 {
		t.Fatal("TrueDown icon has an invalid ICO header")
	}
	count := int(binary.LittleEndian.Uint16(data[4:6]))
	if len(data) < 6+16*count {
		t.Fatal("TrueDown icon directory is truncated")
	}
	want := map[int]bool{16: false, 20: false, 24: false, 32: false, 40: false, 48: false, 64: false, 128: false, 256: false}
	for index := 0; index < count; index++ {
		entry := data[6+16*index : 6+16*(index+1)]
		width := int(entry[0])
		height := int(entry[1])
		if width == 0 {
			width = 256
		}
		if height == 0 {
			height = 256
		}
		if width != height {
			t.Fatalf("TrueDown icon entry is %dx%d, want square", width, height)
		}
		if _, ok := want[width]; ok {
			want[width] = true
		}
	}
	for size, found := range want {
		if !found {
			t.Errorf("TrueDown icon is missing the %dx%d shell size", size, size)
		}
	}
}

func TestMacIconContainsModernPNGRepresentations(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("macos", "truedown.icns"))
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 8 || string(data[:4]) != "icns" || int(binary.BigEndian.Uint32(data[4:8])) != len(data) {
		t.Fatal("TrueDown macOS icon has an invalid ICNS header")
	}
	want := map[string]bool{"icp4": false, "icp5": false, "icp6": false, "ic07": false, "ic08": false, "ic09": false, "ic10": false}
	for offset := 8; offset < len(data); {
		if offset+8 > len(data) {
			t.Fatal("TrueDown ICNS chunk header is truncated")
		}
		kind := string(data[offset : offset+4])
		length := int(binary.BigEndian.Uint32(data[offset+4 : offset+8]))
		if length < 16 || offset+length > len(data) {
			t.Fatalf("TrueDown ICNS chunk %q has invalid length %d", kind, length)
		}
		payload := data[offset+8 : offset+length]
		if len(payload) < 8 || string(payload[1:4]) != "PNG" {
			t.Fatalf("TrueDown ICNS chunk %q is not PNG-backed", kind)
		}
		if _, ok := want[kind]; ok {
			want[kind] = true
		}
		offset += length
	}
	for kind, found := range want {
		if !found {
			t.Errorf("TrueDown ICNS is missing %s", kind)
		}
	}
}

func TestUnixBuildScriptPackagesLinuxAndMacOS(t *testing.T) {
	data, err := os.ReadFile("build-unix.sh")
	if err != nil {
		t.Fatal(err)
	}
	script := string(data)
	for _, contract := range []string{
		"linux|darwin", "amd64|arm64", "CGO_ENABLED=0", "TrueDown.app",
		"macos/truedown.icns", "linux/truedown.desktop", "TRUEDOWN_VERSION",
	} {
		if !strings.Contains(script, contract) {
			t.Errorf("Unix build script is missing %q", contract)
		}
	}
}

func TestWSL2PreparationBuildsApplicationAndTestBinaries(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("tools", "prepare-wsl-tests.ps1"))
	if err != nil {
		t.Fatal(err)
	}
	script := string(data)
	for _, contract := range []string{
		`$env:CGO_ENABLED = "0"`, `$env:GOOS = "linux"`, `$env:GOARCH = "amd64"`,
		"go build -trimpath", "go test -c", "ReparsePoint", "dist", "wsl2",
	} {
		if !strings.Contains(script, contract) {
			t.Errorf("WSL2 preparation script is missing %q", contract)
		}
	}
}

func TestSecureHandlerProtectsResolverModuleEndpointsWithAPIKey(t *testing.T) {
	token := strings.Repeat("m", 32)
	handler := secureHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}), testAuthState(token), "127.0.0.1:15151")

	for _, path := range []string{"/modules", "/modules/package"} {
		request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:15151"+path, strings.NewReader(`{}`))
		request.Header.Set("Origin", "chrome-extension://abcdefghijklmnop")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("unauthorized %s status=%d", path, response.Code)
		}

		request.Header.Set("X-Api-Key", token)
		authorized := httptest.NewRecorder()
		handler.ServeHTTP(authorized, request)
		if authorized.Code != http.StatusNoContent {
			t.Fatalf("authorized %s status=%d", path, authorized.Code)
		}
	}
}

func TestAuthControllerIsOptionalAndPersistsDashboardSetting(t *testing.T) {
	if _, err := newAuthController(t.TempDir(), false, "   "); err == nil {
		t.Fatal("all-whitespace environment token did not make managed authentication fail closed")
	}
	invalidDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(invalidDir, "truedown.auth.json"), []byte("null\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := newAuthController(invalidDir, false, ""); err == nil {
		t.Fatal("non-object auth settings disabled authentication instead of failing closed")
	}
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
	disabledToken, err := reloaded.SetEnabled(false)
	if err != nil {
		t.Fatal(err)
	}
	disabled, residentToken, _ := reloaded.Snapshot()
	if disabled || disabledToken != "" || residentToken != "" || reloaded.TokenPath() != "" {
		t.Fatalf("disabled auth retained token material: enabled=%v returned=%q resident=%q path=%q", disabled, disabledToken, residentToken, reloaded.TokenPath())
	}
	reenabledToken, err := reloaded.SetEnabled(true)
	if err != nil {
		t.Fatal(err)
	}
	if reenabledToken != token {
		t.Fatal("re-enabling authentication did not reuse its persisted API key")
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
	if _, _, err := loadOrCreateAPIToken(dataDir, strings.Repeat("x", 31)+"\t"); err == nil {
		t.Fatal("configured token with a control character was accepted")
	}
	if _, _, err := loadOrCreateAPIToken(dataDir, strings.Repeat("x", 32)+" "); err == nil {
		t.Fatal("configured token with surrounding whitespace was accepted")
	}
	if _, _, err := loadOrCreateAPIToken(dataDir, "   "); err == nil {
		t.Fatal("all-whitespace configured token was treated as unset")
	}
	if err := validateAPIToken(strings.Repeat("x", 31) + "é"); err == nil || !strings.Contains(err.Error(), "printable ASCII") {
		t.Fatalf("non-ASCII token error=%v", err)
	}
	persistedDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(persistedDir, "truedown.token"), []byte(strings.Repeat("x", 32)+"é\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := loadOrCreateAPIToken(persistedDir, ""); err == nil || !strings.Contains(err.Error(), "printable ASCII") {
		t.Fatalf("persisted non-ASCII token error=%v", err)
	}
	crlfDir := t.TempDir()
	maximumToken := strings.Repeat("z", 256)
	if err := validateAPIToken(maximumToken); err != nil {
		t.Fatalf("256-byte printable ASCII token was rejected: %v", err)
	}
	if err := validateAPIToken(maximumToken + "z"); err == nil {
		t.Fatal("257-byte printable ASCII token was accepted")
	}
	if err := os.WriteFile(filepath.Join(crlfDir, "truedown.token"), []byte(maximumToken+"\r\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if token, _, err := loadOrCreateAPIToken(crlfDir, ""); err != nil || token != maximumToken {
		t.Fatalf("persisted 256-byte CRLF token length=%d err=%v", len(token), err)
	}
	invalidDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(invalidDir, "truedown.token"), []byte(strings.Repeat("x", 32)+"\x7f\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := loadOrCreateAPIToken(invalidDir, ""); err == nil || !strings.Contains(err.Error(), "printable ASCII") {
		t.Fatalf("persisted control-character token error=%v", err)
	}
	for name, contents := range map[string]string{
		"leading-space":  " " + strings.Repeat("x", 32) + "\n",
		"trailing-space": strings.Repeat("x", 32) + " \n",
		"extra-newline":  strings.Repeat("x", 32) + "\n\n",
	} {
		t.Run(name, func(t *testing.T) {
			dataDir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dataDir, "truedown.token"), []byte(contents), 0600); err != nil {
				t.Fatal(err)
			}
			if _, _, err := loadOrCreateAPIToken(dataDir, ""); err == nil || !strings.Contains(err.Error(), "without surrounding whitespace") {
				t.Fatalf("invalid persisted token error=%v", err)
			}
		})
	}
}
