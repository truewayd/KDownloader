package api

import (
	"errors"
	"net/http"
	"truedown/internal/downloader"
)

func registerTaskDefaults(mux *http.ServeMux, dm *downloader.Manager) {
	mux.HandleFunc("/settings/task-defaults", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, dm.TaskDefaults())
		case http.MethodPost:
			var request struct {
				Revision *uint64                  `json:"revision"`
				Values   *downloader.TaskDefaults `json:"values"`
			}
			if !decodeJSONRequest(w, r, 64*1024, &request) {
				return
			}
			if request.Revision == nil || request.Values == nil {
				http.Error(w, "revision and values are required", http.StatusBadRequest)
				return
			}
			state, err := dm.SetTaskDefaults(*request.Revision, *request.Values)
			if err != nil {
				switch {
				case errors.Is(err, downloader.ErrDefaultsConflict):
					http.Error(w, err.Error(), http.StatusConflict)
				case downloader.IsValidationError(err):
					http.Error(w, err.Error(), http.StatusBadRequest)
				default:
					http.Error(w, "failed to persist task defaults", http.StatusInternalServerError)
				}
				return
			}
			writeJSON(w, http.StatusOK, state)
		default:
			w.Header().Set("Allow", "GET, POST")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
}
