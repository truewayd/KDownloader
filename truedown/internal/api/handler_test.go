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
