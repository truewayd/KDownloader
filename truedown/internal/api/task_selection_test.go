package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"truedown/internal/downloader"
)

func TestSelectionEndpointIgnoresViewportLimitAndHonorsFilters(t *testing.T) {
	handler, manager := testHandler(t)
	defer manager.Stop()
	for index := 0; index < 205; index++ {
		_, _, err := manager.AddTask(fmt.Sprintf("https://example.test/%d", index), "selected.jpg", "", nil, "", 0, downloader.Aria2Opts{})
		if err != nil {
			t.Fatal(err)
		}
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/tasks/selection?search=selected", nil))
	var result struct {
		Tasks []downloader.TaskSelectionEntry `json:"tasks"`
	}
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &result) != nil || len(result.Tasks) != 205 {
		t.Fatalf("status=%d count=%d", response.Code, len(result.Tasks))
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/tasks/selection?status=done", nil))
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &result) != nil || len(result.Tasks) != 0 {
		t.Fatal("status filter ignored")
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/tasks/selection", nil))
	if response.Code != 405 {
		t.Fatal("selection accepted a mutation method")
	}
}
