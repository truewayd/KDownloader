package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"truedown/internal/downloader"
)

func TestKDownloaderCapabilityAndModuleOnlyDispatch(t *testing.T) {
	mux, manager := testHandler(t)
	defer manager.Stop()
	capability := httptest.NewRecorder()
	mux.ServeHTTP(capability, httptest.NewRequest("GET", "/integrations/kdownloader/v1/capabilities", nil))
	var caps struct {
		Protocol string `json:"protocol"`
		Version  int    `json:"version"`
		Resolve  bool   `json:"resolve"`
		Modules  []any  `json:"modules"`
	}
	if json.Unmarshal(capability.Body.Bytes(), &caps) != nil || caps.Protocol != "kdownloader.resolve" || caps.Version != 1 || !caps.Resolve || len(caps.Modules) != 2 {
		t.Fatalf("capability: %s", capability.Body.String())
	}
	send := func(link string) map[string]any {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"link": link})
		request := httptest.NewRequest("POST", "/integrations/kdownloader/v1/resolve", strings.NewReader(string(body)))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, request)
		var result map[string]any
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil {
			t.Fatalf("resolve: %s", response.Body.String())
		}
		return result
	}
	for _, link := range []string{"https://example.com/file", "https://dropbox.com.evil.test/s/id/a", "https://user:pass@www.dropbox.com/s/id/a", "http://www.dropbox.com/s/id/a"} {
		if result := send(link); result["accepted"] != false || result["reason"] != "unsupported" {
			t.Fatalf("unexpected result: %#v", result)
		}
	}
	link := "https://www.dropbox.com/s/id/example.bin?dl=0"
	if _, err := manager.SetModuleInstalled(downloader.DropboxModuleID, false); err != nil {
		t.Fatal(err)
	}
	if result := send(link); result["accepted"] != false || result["reason"] != "disabled" {
		t.Fatalf("disabled: %#v", result)
	}
	if manager.DownloadIssues().Dropbox != 1 {
		t.Fatal("disabled module was not reported")
	}
	if _, err := manager.SetModuleInstalled(downloader.DropboxModuleID, true); err != nil {
		t.Fatal(err)
	}
	first := send(link)
	if first["accepted"] != true || first["module"] != "dropbox" || len(first["taskIds"].([]any)) != 1 {
		t.Fatalf("accepted: %#v", first)
	}
	second := send(link)
	if second["accepted"] != true || second["duplicates"] != float64(1) {
		t.Fatalf("duplicate: %#v", second)
	}
}
