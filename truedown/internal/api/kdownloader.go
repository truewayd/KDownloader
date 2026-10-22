package api

import (
	"context"
	"net/http"
	"time"
	"truedown/internal/downloader"
)

// This namespace is deliberately independent of ABDM's integration contract.
func registerKDownloader(mux *http.ServeMux, dm *downloader.Manager) {
	mux.HandleFunc("/system/download-issues", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			http.Error(w, "method not allowed", 405)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, 200, dm.DownloadIssues())
	})
	mux.HandleFunc("/integrations/kdownloader/v1/capabilities", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			http.Error(w, "method not allowed", 405)
			return
		}
		modules := make([]map[string]any, 0, 3)
		for _, module := range dm.Modules() {
			if module.ID == downloader.DropboxModuleID || module.ID == downloader.GoogleDriveModuleID || module.ID == downloader.MediaFireModuleID {
				modules = append(modules, map[string]any{"id": module.ID, "enabled": module.Installed})
			}
		}
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, 200, map[string]any{"protocol": "kdownloader.resolve", "version": 1, "resolve": true, "modules": modules})
	})
	mux.HandleFunc("/integrations/kdownloader/v1/resolve", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			http.Error(w, "method not allowed", 405)
			return
		}
		var request struct {
			Link string `json:"link"`
		}
		if !decodeJSONRequest(w, r, 16*1024, &request) {
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
		defer cancel()
		result, reason := dm.ResolveIntegrationLink(ctx, request.Link)
		ids := make([]int64, 0, len(result.Tasks))
		for _, task := range result.Tasks {
			if task != nil {
				ids = append(ids, task.ID)
			}
		}
		writeJSON(w, 200, map[string]any{
			"protocol": "kdownloader.resolve", "version": 1, "link": request.Link,
			"accepted": reason == "", "reason": reason, "module": result.ModuleID,
			"taskIds": ids, "filtered": result.Filtered, "duplicates": result.Duplicates,
		})
	})
}
