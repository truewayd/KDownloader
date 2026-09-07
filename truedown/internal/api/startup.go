package api

import "net/http"

// The native shell owns OS login registration and intercepts this route through
// its private transport. An independent HTTP service must never register itself
// as a desktop launcher; it can be managed by the user's OS service manager.
const startupUnavailable = "请在 TrueDown 桌面设置中配置登录时启动；独立内核请使用系统服务管理器。"

func RegisterStartup(mux *http.ServeMux) {
	mux.HandleFunc("/settings/startup", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, struct {
				Supported bool   `json:"supported"`
				Enabled   bool   `json:"enabled"`
				Reason    string `json:"reason"`
			}{Reason: startupUnavailable})
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
			http.Error(w, startupUnavailable, http.StatusConflict)
		default:
			w.Header().Set("Allow", "GET, POST")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
	})
}
