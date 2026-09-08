package api

import (
	"errors"
	"net/http"
	"truedown/internal/downloader"
)

func registerTaskDetails(mux *http.ServeMux, dm *downloader.Manager) {
	mux.HandleFunc("/tasks/detail", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			w.Header().Set("Allow", "GET, POST")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		id, err := taskID(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		var detail downloader.TaskDetails
		if r.Method == http.MethodGet {
			detail, err = dm.TaskDetails(id)
		} else {
			var req struct {
				Revision string                   `json:"revision"`
				Values   *downloader.TaskSettings `json:"values"`
			}
			if !decodeJSONRequest(w, r, 4096, &req) {
				return
			}
			if req.Values == nil {
				http.Error(w, "values are required", http.StatusBadRequest)
				return
			}
			detail, err = dm.SetTaskSettings(id, req.Revision, *req.Values)
		}
		if err != nil {
			code := http.StatusInternalServerError
			switch {
			case errors.Is(err, downloader.ErrTaskNotFound):
				code = http.StatusNotFound
			case errors.Is(err, downloader.ErrTaskSettingsConflict):
				code = http.StatusConflict
			case downloader.IsValidationError(err):
				code = http.StatusBadRequest
			}
			http.Error(w, err.Error(), code)
			return
		}
		writeJSON(w, http.StatusOK, detail)
	})
}
