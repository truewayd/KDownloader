package api

import (
	"net/http"
	"truedown/internal/startup"
)

type StartupService interface {
	Snapshot() (startup.State, error)
	SetEnabled(bool) (startup.State, error)
}

func RegisterStartup(mux *http.ServeMux, service StartupService) {
	mux.HandleFunc("/settings/startup", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		var state startup.State
		var err error
		switch r.Method {
		case http.MethodGet:
			state, err = service.Snapshot()
		case http.MethodPost:
			var request struct {
				Enabled *bool `json:"enabled"`
			}
			if !decodeJSONRequest(w, r, 4096, &request) {
				return
			}
			if request.Enabled == nil {
				http.Error(w, "enabled is required", http.StatusBadRequest)
				return
			}
			state, err = service.SetEnabled(*request.Enabled)
		default:
			w.Header().Set("Allow", "GET, POST")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		writeJSON(w, http.StatusOK, state)
	})
}
