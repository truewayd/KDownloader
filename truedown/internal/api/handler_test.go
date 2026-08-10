package api

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"truedown/internal/downloader"
)

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
	Register(mux, manager)
	return mux, manager
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
