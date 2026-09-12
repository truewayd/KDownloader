package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"truedown/internal/systemupdate"
)

type queuedUpdateFixture struct {
	testUpdateService
	operation string
}

func (service *queuedUpdateFixture) StartUpdate(operation string) (systemupdate.Snapshot, error) {
	service.operation = operation
	return systemupdate.Snapshot{Busy: operation}, nil
}

func TestUpdateBackgroundQueryReturnsAcceptedWithoutWaiting(t *testing.T) {
	service := &queuedUpdateFixture{}
	request := httptest.NewRequest("POST", "/system/update/check?background=true", nil)
	response := httptest.NewRecorder()
	if !startBackgroundUpdate(response, request, service, "truedown") {
		t.Fatal("background request was not handled")
	}
	if response.Code != http.StatusAccepted || service.operation != "truedown" {
		t.Fatal("missing async admission", response.Code, service.operation)
	}
	response = httptest.NewRecorder()
	if startBackgroundUpdate(response, httptest.NewRequest("POST", "/system/update/check", nil), service, "truedown") {
		t.Fatal("legacy synchronous request changed")
	}
}
