package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"truedown/internal/downloader"
)

func TestTaskDefaultsAPIAndOptInSubmission(t *testing.T) {
	mux, manager := testHandler(t)
	defer manager.Stop()
	send := func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			r.Header.Set("Content-Type", "application/json")
		}
		mux.ServeHTTP(w, r)
	}
	defaults := manager.TaskDefaults()
	defaults.Values.Connections = 7
	defaults.Values.Headers = `{"Cookie":"private-default-cookie"}`
	data, _ := json.Marshal(defaults)
	post := httptest.NewRecorder()
	send(post, httptest.NewRequest("POST", "/settings/task-defaults", bytes.NewReader(data)))
	if post.Code != 200 {
		t.Fatal(post.Code, post.Body.String())
	}
	stale := httptest.NewRecorder()
	send(stale, httptest.NewRequest("POST", "/settings/task-defaults", bytes.NewReader(data)))
	if stale.Code != 409 {
		t.Fatal(stale.Code)
	}
	for _, body := range []string{`{}`, `{"revision":1,"values":null}`, `{"revision":1,"values":{},"unknown":true}`} {
		response := httptest.NewRecorder()
		send(response, httptest.NewRequest("POST", "/settings/task-defaults", strings.NewReader(body)))
		if response.Code != 400 {
			t.Fatal(body, response.Code)
		}
	}
	for _, body := range []string{
		`{"downloadSource":{"link":"https://example.com/legacy"}}`,
		`{"downloadSource":{"link":"https://example.com/defaults"},"useDefaults":true}`,
	} {
		response := httptest.NewRecorder()
		send(response, httptest.NewRequest("POST", "/start-headless-download", strings.NewReader(body)))
		if response.Code != 200 {
			t.Fatal(response.Code, response.Body.String())
		}
	}
	page := manager.PageTaskSnapshots(0, 100, downloader.Status(""), "")
	if len(page.Tasks) != 2 {
		t.Fatal(len(page.Tasks))
	}
	for _, snapshot := range page.Tasks {
		task, _ := manager.GetTask(snapshot.ID)
		if strings.HasSuffix(task.Link, "/defaults") {
			if task.Opts.Connections != 7 || task.Headers["Cookie"] != "private-default-cookie" {
				t.Fatal("missing default")
			}
		} else if task.Headers["Cookie"] != "" || task.Opts.Connections != 0 {
			t.Fatal("legacy client changed")
		}
	}
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/tasks?limit=100", nil))
	if strings.Contains(response.Body.String(), "private-default-cookie") {
		t.Fatal("secret reached task page")
	}
}
