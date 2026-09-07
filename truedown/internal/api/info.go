package api

import (
	"net/http"
	"truedown/internal/protocol"
)

// RegisterInfo is mounted inside the same authenticated boundary as task APIs.
func RegisterInfo(mux *http.ServeMux, info protocol.Info) {
	mux.HandleFunc("/system/info", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		writeJSON(w, http.StatusOK, info)
	})
}
