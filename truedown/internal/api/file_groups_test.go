package api

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFileGroupsAndTaskDetailsAPI(t *testing.T) {
	mux, manager := testHandler(t)
	defer manager.Stop()
	for _, path := range []string{"/settings/file-groups", "/tasks"} {
		reply := httptest.NewRecorder()
		mux.ServeHTTP(reply, httptest.NewRequest("GET", path, nil))
		if reply.Code != 200 || !strings.Contains(reply.Body.String(), `"project"`) {
			t.Fatal(path, reply.Code, reply.Body.String())
		}
	}
	state := manager.FileGroups()
	data, _ := json.Marshal(map[string]any{"revision": state.Revision, "groups": state.Groups})
	for _, expected := range []int{200, 409} {
		reply := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/settings/file-groups", bytes.NewReader(data))
		req.Header.Set("Content-Type", "application/json")
		mux.ServeHTTP(reply, req)
		if reply.Code != expected {
			t.Fatal(reply.Code, reply.Body.String())
		}
	}
	for _, body := range []string{`{}`, `{"revision":1,"groups":[]}`, `{"revision":1,"groups":null}`, `{"revision":1,"groups":[],"path":"escape"}`} {
		reply := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/settings/file-groups", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		mux.ServeHTTP(reply, req)
		if reply.Code != 400 {
			t.Fatal(body, reply.Code)
		}
	}
	for _, path := range []string{"/tasks/detail?id=0", "/tasks/detail?id=nope"} {
		reply := httptest.NewRecorder()
		mux.ServeHTTP(reply, httptest.NewRequest("GET", path, nil))
		if reply.Code != 400 {
			t.Fatal(path, reply.Code)
		}
	}
	reply := httptest.NewRecorder()
	mux.ServeHTTP(reply, httptest.NewRequest("GET", "/tasks/detail?id=999", nil))
	if reply.Code != 404 {
		t.Fatal(reply.Code)
	}
}
