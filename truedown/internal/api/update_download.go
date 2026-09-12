package api

import (
	"net/http"
	"truedown/internal/systemupdate"
)

type backgroundUpdateService interface {
	StartUpdate(string) (systemupdate.Snapshot, error)
}

func startBackgroundUpdate(w http.ResponseWriter, r *http.Request, updates UpdateService, operation string) bool {
	if r.URL.Query().Get("background") != "true" {
		return false
	}
	service, ok := updates.(backgroundUpdateService)
	if !ok {
		http.Error(w, "Background updates are unavailable", http.StatusNotImplemented)
		return true
	}
	snapshot, err := service.StartUpdate(operation)
	if err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return true
	}
	writeJSON(w, http.StatusAccepted, snapshot)
	return true
}
