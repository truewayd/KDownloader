package api

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"truedown/internal/downloader"
)

func TestArchiveEndpointValidatesAndForwardsPages(t *testing.T) {
	calls := 0
	handler := archivePreviewHandler(func(id int64, cursor int, version string) (downloader.ArchivePreview, error) {
		calls++
		if id != 42 || cursor != 200 || version != "snapshot" {
			t.Fatalf("arguments: %d %d %q", id, cursor, version)
		}
		return downloader.ArchivePreview{Version: version, Cursor: cursor, Entries: []downloader.ArchiveEntry{{Name: "literal<script>.txt"}}}, nil
	})
	response := httptest.NewRecorder()
	handler(response, httptest.NewRequest("GET", "/tasks/archive-preview?id=42&cursor=200&version=snapshot", nil))
	if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store" || calls != 1 {
		t.Fatalf("response: %+v", response)
	}
	for _, query := range []string{"", "?id=-1", "?id=42&id=43", "?id=42&cursor=-1", "?id=42&cursor=100001", "?id=42&cursor=NaN"} {
		r := httptest.NewRecorder()
		handler(r, httptest.NewRequest("GET", "/tasks/archive-preview"+query, nil))
		if r.Code != 400 {
			t.Fatalf("%s: %d", query, r.Code)
		}
	}
	r := httptest.NewRecorder()
	handler(r, httptest.NewRequest("POST", "/tasks/archive-preview?id=42", nil))
	if r.Code != 405 {
		t.Fatal(r.Code)
	}
	if calls != 1 {
		t.Fatal("invalid requests reached reader")
	}
	failing := archivePreviewHandler(func(int64, int, string) (downloader.ArchivePreview, error) {
		return downloader.ArchivePreview{}, fmt.Errorf("Archive changed during preview")
	})
	r = httptest.NewRecorder()
	failing(r, httptest.NewRequest(http.MethodGet, "/tasks/archive-preview?id=42", nil))
	if r.Code != 400 {
		t.Fatal(r.Code)
	}
}

func TestArchiveRegisteredEndpointRejectsMissingAndUnfinished(t *testing.T) {
	handler, m := testHandler(t)
	defer m.Stop()
	task, _, err := m.AddTask("https://example.test/unfinished.zip", "unfinished.zip", "", nil, "", 0, downloader.Aria2Opts{})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{task.ID, 999999} {
		r := httptest.NewRecorder()
		handler.ServeHTTP(r, httptest.NewRequest("GET", fmt.Sprintf("/tasks/archive-preview?id=%d", id), nil))
		if r.Code != 400 {
			t.Fatalf("id=%d status=%d", id, r.Code)
		}
	}
}
