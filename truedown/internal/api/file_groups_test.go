package api

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestFileGroupOrderPreservesDefinitionsAndRejectsStaleOrPartialOrders(t *testing.T) {
	mux, manager := testHandler(t)
	defer manager.Stop()
	before := manager.FileGroups()
	ids := make([]string, len(before.Groups))
	for i, group := range before.Groups {
		ids[len(ids)-1-i] = group.ID
	}
	post := func(value any) *httptest.ResponseRecorder {
		data, _ := json.Marshal(value)
		reply := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/settings/file-groups/order", bytes.NewReader(data))
		req.Header.Set("Content-Type", "application/json")
		mux.ServeHTTP(reply, req)
		return reply
	}
	for _, invalid := range [][]string{ids[:len(ids)-1], append([]string{ids[1]}, ids[1:]...), append([]string{"missing"}, ids[1:]...)} {
		if reply := post(map[string]any{"revision": before.Revision, "ids": invalid}); reply.Code != 400 {
			t.Fatal(reply.Code, reply.Body.String())
		}
		if !reflect.DeepEqual(before, manager.FileGroups()) {
			t.Fatal("invalid order changed groups")
		}
	}
	if reply := post(map[string]any{"revision": before.Revision, "ids": ids}); reply.Code != 200 {
		t.Fatal(reply.Code, reply.Body.String())
	}
	after := manager.FileGroups()
	for i, group := range after.Groups {
		if !reflect.DeepEqual(group, before.Groups[len(ids)-1-i]) {
			t.Fatal("order changed a group definition")
		}
	}
	if reply := post(map[string]any{"revision": before.Revision, "ids": ids}); reply.Code != 409 {
		t.Fatal("stale order accepted", reply.Code)
	}
	if !reflect.DeepEqual(after, manager.FileGroups()) {
		t.Fatal("stale order changed groups")
	}
}

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
