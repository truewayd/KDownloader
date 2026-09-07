package api

import (
	"net/http"
	"truedown/internal/profile"
)

func RegisterStorage(mux *http.ServeMux, location profile.Location) {
	mux.HandleFunc("/system/storage", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			http.Error(w, "method not allowed", 405)
			return
		}
		writeJSON(w, 200, location)
	})
}
