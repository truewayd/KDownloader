package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"truedown/internal/downloader"
)

type testTokenAuth struct {
	enabled bool
	token   string
	managed bool
}

func (auth *testTokenAuth) Snapshot() (bool, string, bool) {
	return auth.enabled, auth.token, auth.managed
}

func (auth *testTokenAuth) SetEnabled(enabled bool) (string, error) {
	if auth.managed && enabled != auth.enabled {
		return "", fmt.Errorf("managed")
	}
	auth.enabled = enabled
	if enabled && auth.token == "" {
		auth.token = strings.Repeat("n", 32)
	}
	return auth.token, nil
}

func testHandler(t *testing.T) (*http.ServeMux, *downloader.Manager) {
	t.Helper()
	root := t.TempDir()
	manager, err := downloader.NewManager(
		"unused",
		filepath.Join(root, "downloads"),
		filepath.Join(root, "records.db"),
	)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	Register(mux, manager, &testTokenAuth{enabled: true, token: strings.Repeat("t", 32)})
	return mux, manager
}

func TestTaskPageIsBoundedAndSupportsConditionalRequests(t *testing.T) {
	mux, manager := testHandler(t)
	defer manager.Stop()
	for _, name := range []string{"one", "two", "three"} {
		if _, _, err := manager.AddTask("https://example.test/"+name, name+".bin", "", nil, "", 0, downloader.Aria2Opts{}); err != nil {
			t.Fatal(err)
		}
	}
	request := httptest.NewRequest(http.MethodGet, "/tasks?limit=2&offset=0&status=all", nil)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("page status=%d body=%s", response.Code, response.Body.String())
	}
	var page downloader.TaskPage
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.Total != 3 || len(page.Tasks) != 2 || page.Tasks[0].ID != 3 || page.Tasks[1].ID != 2 {
		t.Fatalf("unexpected page: %+v", page)
	}
	etag := response.Header().Get("ETag")
	if etag == "" {
		t.Fatal("task page did not include an ETag")
	}
	conditional := httptest.NewRequest(http.MethodGet, "/tasks?limit=2&offset=0&status=all", nil)
	conditional.Header.Set("If-None-Match", etag)
	conditionalResponse := httptest.NewRecorder()
	mux.ServeHTTP(conditionalResponse, conditional)
	if conditionalResponse.Code != http.StatusNotModified {
		t.Fatalf("conditional status=%d, want 304", conditionalResponse.Code)
	}

	invalid := httptest.NewRequest(http.MethodGet, "/tasks?limit=2&status=unknown", nil)
	invalidResponse := httptest.NewRecorder()
	mux.ServeHTTP(invalidResponse, invalid)
	if invalidResponse.Code != http.StatusBadRequest {
		t.Fatalf("invalid filter status=%d", invalidResponse.Code)
	}

	search := httptest.NewRequest(http.MethodGet, "/tasks?search=TWO.BIN", nil)
	searchResponse := httptest.NewRecorder()
	mux.ServeHTTP(searchResponse, search)
	if searchResponse.Code != http.StatusOK {
		t.Fatalf("search status=%d body=%s", searchResponse.Code, searchResponse.Body.String())
	}
	var searchPage downloader.TaskPage
	if err := json.Unmarshal(searchResponse.Body.Bytes(), &searchPage); err != nil {
		t.Fatal(err)
	}
	if searchPage.Total != 1 || len(searchPage.Tasks) != 1 || searchPage.Tasks[0].Name != "two.bin" {
		t.Fatalf("unexpected search page: %+v", searchPage)
	}

	sorted := httptest.NewRequest(http.MethodGet, "/tasks?limit=3&sort=file&order=asc", nil)
	sortedResponse := httptest.NewRecorder()
	mux.ServeHTTP(sortedResponse, sorted)
	if sortedResponse.Code != http.StatusOK {
		t.Fatalf("sorted page status=%d body=%s", sortedResponse.Code, sortedResponse.Body.String())
	}
	var sortedPage downloader.TaskPage
	if err := json.Unmarshal(sortedResponse.Body.Bytes(), &sortedPage); err != nil {
		t.Fatal(err)
	}
	if len(sortedPage.Tasks) != 3 || sortedPage.Tasks[0].Name != "one.bin" ||
		sortedPage.Tasks[1].Name != "three.bin" || sortedPage.Tasks[2].Name != "two.bin" {
		t.Fatalf("unexpected sorted page: %+v", sortedPage)
	}
	sortedConditional := httptest.NewRequest(http.MethodGet, "/tasks?limit=3&sort=file&order=asc", nil)
	sortedConditional.Header.Set("If-None-Match", sortedResponse.Header().Get("ETag"))
	sortedConditionalResponse := httptest.NewRecorder()
	mux.ServeHTTP(sortedConditionalResponse, sortedConditional)
	if sortedConditionalResponse.Code != http.StatusNotModified || sortedConditionalResponse.Body.Len() != 0 {
		t.Fatalf("sorted conditional status=%d body=%s", sortedConditionalResponse.Code, sortedConditionalResponse.Body.String())
	}
	for _, target := range []string{
		"/tasks?sort=unknown&order=asc",
		"/tasks?sort=file&order=sideways",
		"/tasks?order=desc",
	} {
		invalidSort := httptest.NewRequest(http.MethodGet, target, nil)
		invalidSortResponse := httptest.NewRecorder()
		mux.ServeHTTP(invalidSortResponse, invalidSort)
		if invalidSortResponse.Code != http.StatusBadRequest {
			t.Fatalf("invalid sort %s status=%d", target, invalidSortResponse.Code)
		}
	}
}

func TestBatchEndpointRejectsMalformedOperations(t *testing.T) {
	mux, manager := testHandler(t)
	defer manager.Stop()
	for _, testCase := range []struct {
		body   string
		status int
	}{
		{`{"action":"pause","ids":[]}`, http.StatusBadRequest},
		{`{"action":"destroy","ids":[1]}`, http.StatusBadRequest},
		{`{"action":"pause","ids":[1],"extra":true}`, http.StatusBadRequest},
	} {
		request := httptest.NewRequest(http.MethodPost, "/tasks/batch", strings.NewReader(testCase.body))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, request)
		if response.Code != testCase.status {
			t.Fatalf("body=%s status=%d want=%d response=%s", testCase.body, response.Code, testCase.status, response.Body.String())
		}
	}
}

func TestTokenEndpointDoesNotCacheSecret(t *testing.T) {
	mux, manager := testHandler(t)
	defer manager.Stop()
	request := httptest.NewRequest(http.MethodGet, "/auth/token", nil)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" ||
		!strings.Contains(response.Body.String(), `"enabled":true`) || !strings.Contains(response.Body.String(), strings.Repeat("t", 32)) {
		t.Fatalf("unexpected token response: status=%d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
	}

	disabledMux := http.NewServeMux()
	Register(disabledMux, manager, &testTokenAuth{})
	disabledRequest := httptest.NewRequest(http.MethodGet, "/auth/token", nil)
	disabledResponse := httptest.NewRecorder()
	disabledMux.ServeHTTP(disabledResponse, disabledRequest)
	if disabledResponse.Code != http.StatusOK || disabledResponse.Body.String() != "{\"enabled\":false}\n" {
		t.Fatalf("disabled token response: status=%d body=%s", disabledResponse.Code, disabledResponse.Body.String())
	}
}

func TestAuthSettingsToggleReturnsSessionWithoutBreakingDashboardRequests(t *testing.T) {
	root := t.TempDir()
	manager, err := downloader.NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Stop()
	auth := &testTokenAuth{}
	mux := http.NewServeMux()
	Register(mux, manager, auth)

	enable := httptest.NewRequest(http.MethodPost, "/auth/settings", strings.NewReader(`{"enabled":true}`))
	enable.Header.Set("Content-Type", "application/json")
	enableResponse := httptest.NewRecorder()
	mux.ServeHTTP(enableResponse, enable)
	if enableResponse.Code != http.StatusOK || !auth.enabled || !strings.Contains(enableResponse.Body.String(), auth.token) {
		t.Fatalf("enable status=%d auth=%+v body=%s", enableResponse.Code, auth, enableResponse.Body.String())
	}
	cookies := enableResponse.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != SessionCookieName || cookies[0].Value != auth.token || !cookies[0].HttpOnly {
		t.Fatalf("enable cookies=%+v", cookies)
	}

	disable := httptest.NewRequest(http.MethodPost, "/auth/settings", strings.NewReader(`{"enabled":false}`))
	disable.Header.Set("Content-Type", "application/json")
	disableResponse := httptest.NewRecorder()
	mux.ServeHTTP(disableResponse, disable)
	if disableResponse.Code != http.StatusOK || auth.enabled {
		t.Fatalf("disable status=%d auth=%+v body=%s", disableResponse.Code, auth, disableResponse.Body.String())
	}
	disableCookies := disableResponse.Result().Cookies()
	if len(disableCookies) != 1 || disableCookies[0].Name != SessionCookieName || disableCookies[0].MaxAge >= 0 {
		t.Fatalf("disable cookies=%+v", disableCookies)
	}
}

func TestStartDownloadValidatesContentTypeAndURL(t *testing.T) {
	mux, manager := testHandler(t)
	defer manager.Stop()

	for _, testCase := range []struct {
		contentType string
		body        string
		status      int
	}{
		{"text/plain", `{"downloadSource":{"link":"https://example.test/file"}}`, http.StatusUnsupportedMediaType},
		{"application/json", `{"downloadSource":{"link":"file:///etc/passwd"}}`, http.StatusBadRequest},
		{"application/json", `{"downloadSource":{"link":"https://example.test/file"},"unknown":true}`, http.StatusBadRequest},
		{"application/json", `{"downloadSource":{"link":"https://example.test/file"},"downloadRules":{"enabled":true}}`, http.StatusBadRequest},
		{"application/json", `{"downloadSource":{"link":"https://example.test/file"},"dropbox":{"mode":"invalid","applyFilter":false}}`, http.StatusBadRequest},
		{"application/json", `{"downloadSource":{"link":"https://example.test/file"},"dropbox":{"mode":"direct","applyFilter":true}}`, http.StatusBadRequest},
		{"application/json", `{"downloadSource":{"link":"https://example.test/file"},"moduleOptions":{"unknown":{}}}`, http.StatusBadRequest},
		{"application/json", `{"downloadSource":{"link":"https://example.test/file"},"moduleOptions":{"google-drive":{"documentFormat":"exe"}}}`, http.StatusBadRequest},
		{"application/json", `{"downloadSource":{"link":"https://example.test/file"},"moduleOptions":{"google-drive":null}}`, http.StatusBadRequest},
	} {
		request := httptest.NewRequest(http.MethodPost, "/start-headless-download", strings.NewReader(testCase.body))
		request.Header.Set("Content-Type", testCase.contentType)
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, request)
		if response.Code != testCase.status {
			t.Fatalf("status=%d, want %d; body=%s", response.Code, testCase.status, response.Body.String())
		}
	}
}

func TestResolverModulesEndpointInstallsAndRemovesBuiltIns(t *testing.T) {
	mux, manager := testHandler(t)
	defer manager.Stop()
	get := httptest.NewRequest(http.MethodGet, "/modules", nil)
	getResponse := httptest.NewRecorder()
	mux.ServeHTTP(getResponse, get)
	if getResponse.Code != http.StatusOK || !strings.Contains(getResponse.Body.String(), `"id":"dropbox"`) ||
		!strings.Contains(getResponse.Body.String(), `"id":"google-drive"`) {
		t.Fatalf("module catalog status=%d body=%s", getResponse.Code, getResponse.Body.String())
	}
	remove := httptest.NewRequest(http.MethodPost, "/modules", strings.NewReader(`{"id":"google-drive","installed":false}`))
	remove.Header.Set("Content-Type", "application/json")
	removeResponse := httptest.NewRecorder()
	mux.ServeHTTP(removeResponse, remove)
	if removeResponse.Code != http.StatusOK || !strings.Contains(removeResponse.Body.String(), `"installed":false`) {
		t.Fatalf("remove module status=%d body=%s", removeResponse.Code, removeResponse.Body.String())
	}
	invalid := httptest.NewRequest(http.MethodPost, "/modules", strings.NewReader(`{"id":"unknown","installed":true}`))
	invalid.Header.Set("Content-Type", "application/json")
	invalidResponse := httptest.NewRecorder()
	mux.ServeHTTP(invalidResponse, invalid)
	if invalidResponse.Code != http.StatusBadRequest {
		t.Fatalf("unknown module status=%d body=%s", invalidResponse.Code, invalidResponse.Body.String())
	}
}

func TestResolverComponentPackageEndpointHotReloadsAndResets(t *testing.T) {
	mux, manager := testHandler(t)
	defer manager.Stop()
	packageJSON := `{
		"schemaVersion":1,
		"id":"google-drive",
		"engine":"google-drive-v1",
		"version":"1.1.0",
		"releasedAt":"2026-08-20",
		"config":{
			"stableDownloadPath":"/uc-v2",
			"openPath":"/open-v2",
			"folderViewPath":"/folder-v2",
			"nativeExportPath":"/compat/{type}/d/{id}/export",
			"userAgent":"TrueDown API test"
		}
	}`
	install := httptest.NewRequest(http.MethodPost, "/modules/package", strings.NewReader(`{"package":`+packageJSON+`}`))
	install.Header.Set("Content-Type", "application/json")
	installResponse := httptest.NewRecorder()
	mux.ServeHTTP(installResponse, install)
	if installResponse.Code != http.StatusOK || !strings.Contains(installResponse.Body.String(), `"source":"updated"`) ||
		!strings.Contains(installResponse.Body.String(), `"baselineVersion":"1.0.0"`) {
		t.Fatalf("install component status=%d body=%s", installResponse.Code, installResponse.Body.String())
	}

	reset := httptest.NewRequest(http.MethodDelete, "/modules/package?id=google-drive", nil)
	resetResponse := httptest.NewRecorder()
	mux.ServeHTTP(resetResponse, reset)
	if resetResponse.Code != http.StatusOK || !strings.Contains(resetResponse.Body.String(), `"source":"baseline"`) {
		t.Fatalf("reset component status=%d body=%s", resetResponse.Code, resetResponse.Body.String())
	}

	invalid := httptest.NewRequest(http.MethodPost, "/modules/package", strings.NewReader(`{"package":{"id":"unknown"}}`))
	invalid.Header.Set("Content-Type", "application/json")
	invalidResponse := httptest.NewRecorder()
	mux.ServeHTTP(invalidResponse, invalid)
	if invalidResponse.Code != http.StatusBadRequest {
		t.Fatalf("invalid component status=%d body=%s", invalidResponse.Code, invalidResponse.Body.String())
	}
}

func TestDropboxFolderDefaultsToDirectArchiveDownload(t *testing.T) {
	mux, manager := testHandler(t)
	defer manager.Stop()
	body := `{"downloadSource":{"link":"https://www.dropbox.com/scl/fo/key/hash?rlkey=read&dl=0"}}`
	request := httptest.NewRequest(http.MethodPost, "/start-headless-download", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("direct Dropbox status=%d body=%s", response.Code, response.Body.String())
	}
	tasks := manager.ListTasks()
	if len(tasks) != 1 || !strings.Contains(tasks[0].Link, "dl=1") || strings.Contains(tasks[0].Link, "dl=0") {
		t.Fatalf("direct Dropbox task=%+v", tasks)
	}
}

func TestRuntimeSettingsEndpointPersistsConcurrency(t *testing.T) {
	mux, manager := testHandler(t)
	defer manager.Stop()
	get := httptest.NewRequest(http.MethodGet, "/settings/runtime", nil)
	getResponse := httptest.NewRecorder()
	mux.ServeHTTP(getResponse, get)
	if getResponse.Code != http.StatusOK || getResponse.Body.String() != "{\"concurrentDownloads\":3}\n" {
		t.Fatalf("default runtime settings status=%d body=%s", getResponse.Code, getResponse.Body.String())
	}
	post := httptest.NewRequest(http.MethodPost, "/settings/runtime", strings.NewReader(`{"concurrentDownloads":6}`))
	post.Header.Set("Content-Type", "application/json")
	postResponse := httptest.NewRecorder()
	mux.ServeHTTP(postResponse, post)
	if postResponse.Code != http.StatusOK || manager.RuntimeSettings().ConcurrentDownloads != 6 {
		t.Fatalf("saved runtime settings status=%d body=%s settings=%+v", postResponse.Code, postResponse.Body.String(), manager.RuntimeSettings())
	}
}

func TestDownloadRulesEndpointPersistsAndValidatesConfig(t *testing.T) {
	root := t.TempDir()
	databasePath := filepath.Join(root, "records.db")
	manager, err := downloader.NewManager("unused", filepath.Join(root, "downloads"), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	Register(mux, manager, &testTokenAuth{})

	get := httptest.NewRequest(http.MethodGet, "/settings/download-rules", nil)
	getResponse := httptest.NewRecorder()
	mux.ServeHTTP(getResponse, get)
	if getResponse.Code != http.StatusOK || !strings.Contains(getResponse.Body.String(), `"enabled":false`) ||
		!strings.Contains(getResponse.Body.String(), `"dropboxMode":"direct"`) ||
		!strings.Contains(getResponse.Body.String(), `".psd"`) {
		t.Fatalf("default rules status=%d body=%s", getResponse.Code, getResponse.Body.String())
	}

	post := httptest.NewRequest(http.MethodPost, "/settings/download-rules", strings.NewReader(
		`{"enabled":true,"excludedExtensions":[".PSD",".clip",".psd"],"dropboxMode":"expand"}`,
	))
	post.Header.Set("Content-Type", "application/json")
	postResponse := httptest.NewRecorder()
	mux.ServeHTTP(postResponse, post)
	if postResponse.Code != http.StatusOK || postResponse.Body.String() !=
		"{\"enabled\":true,\"excludedExtensions\":[\".psd\",\".clip\"],\"dropboxMode\":\"expand\"}\n" {
		t.Fatalf("save rules status=%d body=%s", postResponse.Code, postResponse.Body.String())
	}
	legacy := httptest.NewRequest(http.MethodPost, "/settings/download-rules", strings.NewReader(
		`{"enabled":true,"excludedExtensions":[".psd",".clip"]}`,
	))
	legacy.Header.Set("Content-Type", "application/json")
	legacyResponse := httptest.NewRecorder()
	mux.ServeHTTP(legacyResponse, legacy)
	if legacyResponse.Code != http.StatusOK || !strings.Contains(legacyResponse.Body.String(), `"dropboxMode":"expand"`) {
		t.Fatalf("legacy filter update reset Dropbox mode: status=%d body=%s", legacyResponse.Code, legacyResponse.Body.String())
	}
	for _, body := range []string{
		`{"enabled":true,"excludedExtensions":["../psd"]}`,
		`{"enabled":true,"excludedExtensions":[],"dropboxMode":"archive"}`,
		`{"enabled":true,"excludedExtensions":[],"unknown":true}`,
	} {
		request := httptest.NewRequest(http.MethodPost, "/settings/download-rules", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("body=%s status=%d response=%s", body, response.Code, response.Body.String())
		}
	}
	manager.Stop()

	reloaded, err := downloader.NewManager("unused", filepath.Join(root, "downloads"), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer reloaded.Stop()
	if rules := reloaded.DownloadRules(); !rules.Enabled || rules.DropboxMode != downloader.DropboxModeExpand || len(rules.ExcludedExtensions) != 2 ||
		rules.ExcludedExtensions[0] != ".psd" || rules.ExcludedExtensions[1] != ".clip" {
		t.Fatalf("reloaded rules=%+v", rules)
	}
}

func TestABBrowserIntegrationPingAndAdd(t *testing.T) {
	mux, manager := testHandler(t)
	defer manager.Stop()

	ping := httptest.NewRequest(http.MethodPost, "/ping", strings.NewReader("null"))
	pingResponse := httptest.NewRecorder()
	mux.ServeHTTP(pingResponse, ping)
	if pingResponse.Code != http.StatusOK || pingResponse.Body.String() != "pong" {
		t.Fatalf("ping status=%d body=%q", pingResponse.Code, pingResponse.Body.String())
	}

	body := `{"items":[{"link":"https://example.test/file.bin","downloadPage":"https://example.test/post","headers":{"Referer":"https://example.test/post"},"description":"file","suggestedName":"saved.bin","type":"http"}],"options":{"silentAdd":true,"silentStart":true}}`
	request := httptest.NewRequest(http.MethodPost, "/add", strings.NewReader(body))
	request.Header.Set("Content-Type", "text/plain;charset=UTF-8")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != "OK" {
		t.Fatalf("add status=%d body=%q", response.Code, response.Body.String())
	}
	tasks := manager.ListTasks()
	if len(tasks) != 1 || tasks[0].Link != "https://example.test/file.bin" || tasks[0].Name != "saved.bin" ||
		tasks[0].DownloadPage != "https://example.test/post" || tasks[0].Headers["Referer"] != "https://example.test/post" {
		t.Fatalf("unexpected imported task: %+v", tasks)
	}
}

func TestABBrowserIntegrationRejectsUnsupportedAndMalformedItems(t *testing.T) {
	mux, manager := testHandler(t)
	defer manager.Stop()

	for _, body := range []string{
		`{"items":[],"options":{"silentAdd":false,"silentStart":false}}`,
		`{"items":[{"link":"https://example.test/stream.m3u8","type":"hls"}],"options":{}}`,
		`{"items":[{"link":"file:///etc/passwd","type":"http"}],"options":{}}`,
		`{"items":[{"link":"https://example.test/file","type":"http","unknown":true}],"options":{}}`,
	} {
		request := httptest.NewRequest(http.MethodPost, "/add", strings.NewReader(body))
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("body=%s status=%d response=%s", body, response.Code, response.Body.String())
		}
	}
}

func TestTaskListOmitsSensitiveRequestFields(t *testing.T) {
	mux, manager := testHandler(t)
	defer manager.Stop()

	body := `{"downloadSource":{"link":"https://example.test/file","headers":{"Cookie":"secret=value"}},"name":"file.bin"}`
	request := httptest.NewRequest(http.MethodPost, "/start-headless-download", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("create status=%d; body=%s", response.Code, response.Body.String())
	}

	listRequest := httptest.NewRequest(http.MethodGet, "/tasks", nil)
	listResponse := httptest.NewRecorder()
	mux.ServeHTTP(listResponse, listRequest)
	data, err := io.ReadAll(listResponse.Result().Body)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(data, []byte("secret=value")) || bytes.Contains(data, []byte("headers")) {
		t.Fatalf("task list leaked request headers: %s", data)
	}
}
