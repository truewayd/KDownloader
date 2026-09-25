package api

import (
	"errors"
	"net/http"
	"truedown/internal/downloader"
)

func registerFileGroups(mux *http.ServeMux, dm *downloader.Manager) {
	mux.HandleFunc("/settings/file-groups/order", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Revision *uint64  `json:"revision"`
			IDs      []string `json:"ids"`
		}
		if !decodeJSONRequest(w, r, 4096, &req) {
			return
		}
		if req.Revision == nil || req.IDs == nil {
			http.Error(w, "revision and ids are required", http.StatusBadRequest)
			return
		}
		state, err := dm.ReorderFileGroups(*req.Revision, req.IDs)
		if err != nil {
			code := http.StatusInternalServerError
			if errors.Is(err, downloader.ErrFileGroupsConflict) {
				code = http.StatusConflict
			} else if downloader.IsValidationError(err) {
				code = http.StatusBadRequest
			}
			http.Error(w, err.Error(), code)
			return
		}
		writeJSON(w, http.StatusOK, state)
	})
	mux.HandleFunc("/settings/file-groups", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, dm.FileGroups())
		case http.MethodPost:
			var req struct {
				Revision *uint64                `json:"revision"`
				Groups   []downloader.FileGroup `json:"groups"`
			}
			if !decodeJSONRequest(w, r, 64*1024, &req) {
				return
			}
			if req.Revision == nil || req.Groups == nil {
				http.Error(w, "revision and groups are required", http.StatusBadRequest)
				return
			}
			state, err := dm.SetFileGroups(*req.Revision, req.Groups)
			if err != nil {
				code := http.StatusInternalServerError
				if errors.Is(err, downloader.ErrFileGroupsConflict) {
					code = http.StatusConflict
				} else if downloader.IsValidationError(err) {
					code = http.StatusBadRequest
				}
				http.Error(w, err.Error(), code)
				return
			}
			writeJSON(w, http.StatusOK, state)
		default:
			w.Header().Set("Allow", "GET, POST")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
}
