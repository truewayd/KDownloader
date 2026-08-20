package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"
	"truedown/internal/downloader"
	"truedown/internal/systemupdate"
)

const maxStartRequestBytes = 1024 * 1024
const maxBatchRequestBytes = 64 * 1024
const maxBatchTaskIDs = 1000
const maxBrowserIntegrationItems = 256
const SessionCookieName = "truedown_session"

type TokenAuth interface {
	Snapshot() (enabled bool, token string, managed bool)
	SetEnabled(bool) (string, error)
}

type UpdateService interface {
	Snapshot() systemupdate.Snapshot
	SetSettings(systemupdate.Settings) (systemupdate.Snapshot, error)
	UpdateTrueDown(context.Context) (systemupdate.Snapshot, error)
	InstallNext(context.Context) (systemupdate.Snapshot, error)
	SelectEngine(string) (systemupdate.Snapshot, error)
	RequestRestart() error
}

type downloadSourceReq struct {
	Link         string            `json:"link"`
	Headers      map[string]string `json:"headers"`
	DownloadPage string            `json:"downloadPage"`
}

type startReq struct {
	DownloadSource downloadSourceReq          `json:"downloadSource"`
	Folder         string                     `json:"folder"`
	Name           string                     `json:"name"`
	QueueID        int                        `json:"queueId"`
	Opts           downloader.Aria2Opts       `json:"opts"`
	Dropbox        dropboxStartReq            `json:"dropbox"`
	ModuleOptions  map[string]json.RawMessage `json:"moduleOptions"`
}

type dropboxStartReq struct {
	Mode        string `json:"mode"`
	ApplyFilter bool   `json:"applyFilter"`
}

type browserIntegrationItem struct {
	Link          string            `json:"link"`
	DownloadPage  string            `json:"downloadPage"`
	Headers       map[string]string `json:"headers"`
	Description   string            `json:"description"`
	SuggestedName string            `json:"suggestedName"`
	Type          string            `json:"type"`
}

type browserIntegrationOptions struct {
	SilentAdd   bool `json:"silentAdd"`
	SilentStart bool `json:"silentStart"`
}

type browserIntegrationAddReq struct {
	Items   []browserIntegrationItem  `json:"items"`
	Options browserIntegrationOptions `json:"options"`
}

type batchReq struct {
	Action string  `json:"action"`
	IDs    []int64 `json:"ids"`
}

type authSettingsReq struct {
	Enabled bool `json:"enabled"`
}

type engineSelectionReq struct {
	Engine string `json:"engine"`
}

func Register(mux *http.ServeMux, dm *downloader.Manager, auth TokenAuth, updateServices ...UpdateService) {
	if len(updateServices) > 0 && updateServices[0] != nil {
		registerUpdateEndpoints(mux, updateServices[0])
	}
	mux.HandleFunc("/ping", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write([]byte("pong"))
	})

	mux.HandleFunc("/add", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req browserIntegrationAddReq
		if !decodeBrowserIntegrationRequest(w, r, &req) {
			return
		}
		if len(req.Items) == 0 {
			http.Error(w, "at least one download item is required", http.StatusBadRequest)
			return
		}
		if len(req.Items) > maxBrowserIntegrationItems {
			http.Error(w, "too many download items", http.StatusRequestEntityTooLarge)
			return
		}
		for index, item := range req.Items {
			if item.Type != "http" {
				http.Error(w, fmt.Sprintf("item %d uses unsupported download type %q", index, item.Type), http.StatusBadRequest)
				return
			}
		}
		for index, item := range req.Items {
			_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(6 * time.Minute))
			_, handled, err := dm.AddWithModules(
				r.Context(), item.Link, item.SuggestedName, "", item.Headers,
				item.DownloadPage, 0, downloader.Aria2Opts{}, nil,
			)
			if err == nil && !handled {
				_, _, err = dm.AddTask(
					item.Link, item.SuggestedName, "", item.Headers,
					item.DownloadPage, 0, downloader.Aria2Opts{},
				)
			}
			if err != nil {
				if downloader.IsValidationError(err) {
					http.Error(w, fmt.Sprintf("invalid item %d: %v", index, err), http.StatusBadRequest)
					return
				}
				http.Error(w, "failed to create download task", http.StatusInternalServerError)
				return
			}
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write([]byte("OK"))
	})

	mux.HandleFunc("/auth/token", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		enabled, token, _ := auth.Snapshot()
		response := struct {
			Enabled bool   `json:"enabled"`
			Token   string `json:"token,omitempty"`
		}{Enabled: enabled}
		if enabled {
			response.Token = token
		}
		writeJSON(w, http.StatusOK, response)
	})

	mux.HandleFunc("/auth/settings", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			enabled, _, managed := auth.Snapshot()
			w.Header().Set("Cache-Control", "no-store")
			writeJSON(w, http.StatusOK, map[string]bool{"enabled": enabled, "managed": managed})
		case http.MethodPost:
			var req authSettingsReq
			if !decodeJSONRequest(w, r, 4096, &req) {
				return
			}
			token, err := auth.SetEnabled(req.Enabled)
			if err != nil {
				http.Error(w, err.Error(), http.StatusConflict)
				return
			}
			enabled, _, managed := auth.Snapshot()
			w.Header().Set("Cache-Control", "no-store")
			response := struct {
				Enabled bool   `json:"enabled"`
				Managed bool   `json:"managed"`
				Token   string `json:"token,omitempty"`
			}{Enabled: enabled, Managed: managed}
			if enabled {
				response.Token = token
			}
			setAuthSessionCookie(w, r, enabled, token)
			writeJSON(w, http.StatusOK, response)
		default:
			w.Header().Set("Allow", "GET, POST")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/settings/download-rules", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, dm.DownloadRules())
		case http.MethodPost:
			var req downloader.DownloadRulesUpdate
			if !decodeJSONRequest(w, r, 16*1024, &req) {
				return
			}
			rules, err := dm.UpdateDownloadRules(req)
			if err != nil {
				if downloader.IsValidationError(err) {
					http.Error(w, err.Error(), http.StatusBadRequest)
					return
				}
				http.Error(w, "failed to persist download rules", http.StatusInternalServerError)
				return
			}
			writeJSON(w, http.StatusOK, rules)
		default:
			w.Header().Set("Allow", "GET, POST")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/settings/runtime", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, dm.RuntimeSettings())
		case http.MethodPost:
			var req downloader.RuntimeSettings
			if !decodeJSONRequest(w, r, 4096, &req) {
				return
			}
			settings, err := dm.SetRuntimeSettings(req)
			if err != nil {
				if downloader.IsValidationError(err) {
					http.Error(w, err.Error(), http.StatusBadRequest)
					return
				}
				http.Error(w, "failed to apply runtime settings", http.StatusInternalServerError)
				return
			}
			writeJSON(w, http.StatusOK, settings)
		default:
			w.Header().Set("Allow", "GET, POST")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/modules", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, map[string]any{"modules": dm.Modules()})
		case http.MethodPost:
			var req downloader.ModuleInstallRequest
			if !decodeJSONRequest(w, r, 4096, &req) {
				return
			}
			if req.Installed == nil {
				http.Error(w, "installed is required", http.StatusBadRequest)
				return
			}
			module, err := dm.SetModuleInstalled(req.ID, *req.Installed)
			if err != nil {
				if downloader.IsValidationError(err) {
					http.Error(w, err.Error(), http.StatusBadRequest)
					return
				}
				http.Error(w, "failed to persist resolver module settings", http.StatusInternalServerError)
				return
			}
			writeJSON(w, http.StatusOK, module)
		default:
			w.Header().Set("Allow", "GET, POST")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/modules/package", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		switch r.Method {
		case http.MethodPost:
			var req downloader.ModulePackageInstallRequest
			if !decodeJSONRequest(w, r, 70*1024, &req) {
				return
			}
			module, err := dm.InstallModulePackage(req.Package)
			if err != nil {
				if downloader.IsValidationError(err) {
					http.Error(w, err.Error(), http.StatusBadRequest)
					return
				}
				http.Error(w, "failed to persist resolver component update", http.StatusInternalServerError)
				return
			}
			writeJSON(w, http.StatusOK, module)
		case http.MethodDelete:
			module, err := dm.ResetModulePackage(r.URL.Query().Get("id"))
			if err != nil {
				if downloader.IsValidationError(err) {
					http.Error(w, err.Error(), http.StatusBadRequest)
					return
				}
				http.Error(w, "failed to reset resolver component", http.StatusInternalServerError)
				return
			}
			writeJSON(w, http.StatusOK, module)
		default:
			w.Header().Set("Allow", "POST, DELETE")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/start-headless-download", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req startReq
		if !decodeJSONRequest(w, r, maxStartRequestBytes, &req) {
			return
		}
		if req.DownloadSource.Link == "" {
			http.Error(w, "downloadSource.link is required", http.StatusBadRequest)
			return
		}
		moduleOptions := req.ModuleOptions
		if moduleOptions == nil {
			moduleOptions = make(map[string]json.RawMessage)
		}
		if _, exists := moduleOptions[downloader.DropboxModuleID]; !exists {
			legacyMode := strings.TrimSpace(req.Dropbox.Mode)
			if legacyMode != "" || req.Dropbox.ApplyFilter {
				if legacyMode == "" {
					legacyMode = downloader.DropboxModeDirect
				}
				legacy, _ := json.Marshal(map[string]any{"mode": legacyMode, "applyFilter": req.Dropbox.ApplyFilter})
				moduleOptions[downloader.DropboxModuleID] = legacy
			}
		}
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(6 * time.Minute))
		resolved, handled, resolveErr := dm.AddWithModules(
			r.Context(), req.DownloadSource.Link, req.Name, req.Folder,
			req.DownloadSource.Headers, req.DownloadSource.DownloadPage,
			req.QueueID, req.Opts, moduleOptions,
		)
		if resolveErr != nil {
			if downloader.IsValidationError(resolveErr) {
				http.Error(w, resolveErr.Error(), http.StatusBadRequest)
				return
			}
			http.Error(w, resolveErr.Error(), http.StatusBadGateway)
			return
		}
		if handled {
			writeModuleAddResponse(w, resolved)
			return
		}
		link := req.DownloadSource.Link
		t, duplicate, err := dm.AddTask(
			link,
			req.Name,
			req.Folder,
			req.DownloadSource.Headers,
			req.DownloadSource.DownloadPage,
			req.QueueID,
			req.Opts,
		)
		if err != nil {
			if downloader.IsValidationError(err) {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			http.Error(w, "failed to create download task", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		if duplicate {
			w.Header().Set("X-TrueDown-Duplicate", "true")
			w.Write([]byte("OK " + strconv.FormatInt(t.ID, 10) + " DUPLICATE"))
			return
		}
		w.Write([]byte("OK " + strconv.FormatInt(t.ID, 10)))
	})

	mux.HandleFunc("/queue/pause", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		writeJSON(w, http.StatusOK, dm.PauseQueue())
	})

	mux.HandleFunc("/queue/resume", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		writeJSON(w, http.StatusOK, dm.ResumeQueue())
	})

	mux.HandleFunc("/system/open-downloads", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if err := dm.OpenDownloadDirectory(); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Write([]byte("OK"))
	})

	mux.HandleFunc("/tasks/open-file", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		id, err := taskID(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := dm.OpenTaskFile(id); err != nil {
			if downloader.IsValidationError(err) {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Write([]byte("OK"))
	})

	mux.HandleFunc("/tasks/open-folder", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		id, err := taskID(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := dm.OpenTaskDirectory(id); err != nil {
			if downloader.IsValidationError(err) {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Write([]byte("OK"))
	})

	mux.HandleFunc("/tasks", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		limit, err := boundedQueryInt(r, "limit", 100, 1, 200)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		offset, err := boundedQueryInt(r, "offset", 0, 0, 10_000_000)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		status, err := taskStatusFilter(r.URL.Query().Get("status"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		search := strings.TrimSpace(r.URL.Query().Get("search"))
		if len(search) > 512 {
			http.Error(w, "search is too long", http.StatusBadRequest)
			return
		}
		sortField, sortOrder, err := taskSort(r.URL.Query().Get("sort"), r.URL.Query().Get("order"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		page, notModified := dm.PageTaskSnapshotsSortedIfChanged(
			offset, limit, status, search, sortField, sortOrder, r.Header.Get("If-None-Match"),
		)
		w.Header().Set("ETag", page.Version)
		if notModified {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		writeJSON(w, http.StatusOK, page)
	})

	mux.HandleFunc("/tasks/batch", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req batchReq
		if !decodeJSONRequest(w, r, maxBatchRequestBytes, &req) {
			return
		}
		if req.Action == "requeue-errors" {
			req.IDs = dm.TaskIDsByStatus(downloader.StatusError, maxBatchTaskIDs)
		}
		if len(req.IDs) == 0 {
			http.Error(w, "at least one task id is required", http.StatusBadRequest)
			return
		}
		if req.Action != "requeue-errors" && len(req.IDs) > maxBatchTaskIDs {
			http.Error(w, "too many task ids", http.StatusRequestEntityTooLarge)
			return
		}
		var result downloader.TaskOperationResult
		switch req.Action {
		case "pause":
			result = dm.PauseTasks(req.IDs)
		case "resume":
			result = dm.ResumeTasks(req.IDs)
		case "remove":
			result = dm.RemoveTasks(req.IDs)
		case "requeue", "requeue-errors":
			result = dm.RequeueTasks(req.IDs)
		default:
			http.Error(w, "unsupported batch action", http.StatusBadRequest)
			return
		}
		if req.Action == "requeue-errors" {
			result.Remaining = dm.TaskCountByStatus(downloader.StatusError)
		}
		writeJSON(w, http.StatusOK, result)
	})

	// POST /tasks/{id}/requeue — re-enqueue a failed task
	mux.HandleFunc("/tasks/requeue", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		id, err := taskID(r)
		if err != nil {
			http.Error(w, "invalid id", http.StatusBadRequest)
			return
		}
		if err := dm.RequeueTask(id); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Write([]byte("OK"))
	})

	mux.HandleFunc("/tasks/pause", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		id, err := taskID(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := dm.PauseTask(id); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Write([]byte("OK"))
	})

	mux.HandleFunc("/tasks/resume", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		id, err := taskID(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := dm.ResumeTask(id); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Write([]byte("OK"))
	})

	// POST /tasks/delete — delete a single done/error task by id
	mux.HandleFunc("/tasks/delete", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		id, err := taskID(r)
		if err != nil {
			http.Error(w, "invalid id", http.StatusBadRequest)
			return
		}
		if !dm.DeleteTask(id) {
			http.Error(w, "task not found or still active", http.StatusBadRequest)
			return
		}
		w.Write([]byte("OK"))
	})

	// POST /tasks/clear-done — remove all completed tasks
	mux.HandleFunc("/tasks/clear-done", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		n := dm.ClearDone()
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("OK " + strconv.Itoa(n)))
	})
}

func registerUpdateEndpoints(mux *http.ServeMux, updates UpdateService) {
	mux.HandleFunc("/system/update", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, updates.Snapshot())
	})

	mux.HandleFunc("/settings/updates", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, updates.Snapshot())
		case http.MethodPost:
			var req systemupdate.Settings
			if !decodeJSONRequest(w, r, 4096, &req) {
				return
			}
			snapshot, err := updates.SetSettings(req)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			writeJSON(w, http.StatusOK, snapshot)
		default:
			w.Header().Set("Allow", "GET, POST")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/system/update/check", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(10 * time.Minute))
		snapshot, err := updates.UpdateTrueDown(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		writeJSON(w, http.StatusOK, snapshot)
	})

	mux.HandleFunc("/system/update/restart", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if err := updates.RequestRestart(); err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]bool{"accepted": true})
	})

	mux.HandleFunc("/system/engine/next", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(10 * time.Minute))
		snapshot, err := updates.InstallNext(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		writeJSON(w, http.StatusOK, snapshot)
	})

	mux.HandleFunc("/system/engine/select", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req engineSelectionReq
		if !decodeJSONRequest(w, r, 4096, &req) {
			return
		}
		snapshot, err := updates.SelectEngine(req.Engine)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeJSON(w, http.StatusOK, snapshot)
	})
}

func writeModuleAddResponse(w http.ResponseWriter, result downloader.ModuleAddResult) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-TrueDown-Module", result.ModuleID)
	if result.Collection {
		w.Header().Set("X-TrueDown-Collection", "true")
		w.Header().Set("X-TrueDown-Created", strconv.Itoa(len(result.Tasks)))
		w.Header().Set("X-TrueDown-Filtered", strconv.Itoa(result.Filtered))
		if result.ModuleID == downloader.DropboxModuleID {
			w.Header().Set("X-TrueDown-Dropbox-Expanded", "true")
		}
		response := fmt.Sprintf("OK %d FILES", len(result.Tasks))
		if result.Filtered > 0 {
			response += fmt.Sprintf(" %d FILTERED", result.Filtered)
		}
		if result.Duplicates > 0 {
			response += fmt.Sprintf(" %d DUPLICATE", result.Duplicates)
		}
		w.Write([]byte(response))
		return
	}
	if len(result.Tasks) == 0 || result.Tasks[0] == nil {
		http.Error(w, "resolver module created no task", http.StatusBadGateway)
		return
	}
	task := result.Tasks[0]
	if result.Duplicates > 0 {
		w.Header().Set("X-TrueDown-Duplicate", "true")
		w.Write([]byte("OK " + strconv.FormatInt(task.ID, 10) + " DUPLICATE"))
		return
	}
	w.Write([]byte("OK " + strconv.FormatInt(task.ID, 10)))
}

func setAuthSessionCookie(w http.ResponseWriter, r *http.Request, enabled bool, token string) {
	cookie := &http.Cookie{
		Name:     SessionCookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   r.TLS != nil,
		SameSite: http.SameSiteStrictMode,
	}
	if !enabled {
		cookie.Value = ""
		cookie.MaxAge = -1
	}
	http.SetCookie(w, cookie)
}

func decodeJSONRequest(w http.ResponseWriter, r *http.Request, maxBytes int64, target any) bool {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		http.Error(w, "content type must be application/json", http.StatusUnsupportedMediaType)
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		http.Error(w, "invalid JSON request", http.StatusBadRequest)
		return false
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		http.Error(w, "request must contain one JSON object", http.StatusBadRequest)
		return false
	}
	return true
}

func decodeBrowserIntegrationRequest(w http.ResponseWriter, r *http.Request, target any) bool {
	contentType := strings.TrimSpace(r.Header.Get("Content-Type"))
	if contentType != "" {
		mediaType, _, err := mime.ParseMediaType(contentType)
		if err != nil || (mediaType != "application/json" && mediaType != "text/plain") {
			http.Error(w, "content type must be application/json or text/plain", http.StatusUnsupportedMediaType)
			return false
		}
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxStartRequestBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		http.Error(w, "invalid browser integration request", http.StatusBadRequest)
		return false
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		http.Error(w, "request must contain one JSON object", http.StatusBadRequest)
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		return
	}
}

func boundedQueryInt(r *http.Request, name string, fallback, minimum, maximum int) (int, error) {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < minimum || value > maximum {
		return 0, fmt.Errorf("%s must be between %d and %d", name, minimum, maximum)
	}
	return value, nil
}

func taskStatusFilter(raw string) (downloader.Status, error) {
	switch downloader.Status(strings.TrimSpace(raw)) {
	case "", "all":
		return "", nil
	case downloader.StatusQueued, downloader.StatusDownloading, downloader.StatusPaused, downloader.StatusDone, downloader.StatusError:
		return downloader.Status(strings.TrimSpace(raw)), nil
	default:
		return "", fmt.Errorf("invalid task status")
	}
}

func taskSort(rawField, rawOrder string) (string, string, error) {
	field := strings.ToLower(strings.TrimSpace(rawField))
	order := strings.ToLower(strings.TrimSpace(rawOrder))
	if field == "" {
		if order != "" {
			return "", "", fmt.Errorf("order requires a sort field")
		}
		return "", "", nil
	}
	switch field {
	case "id", "file", "status", "link", "progress":
	default:
		return "", "", fmt.Errorf("invalid task sort field")
	}
	if order == "" {
		order = "asc"
	}
	if order != "asc" && order != "desc" {
		return "", "", fmt.Errorf("task sort order must be asc or desc")
	}
	return field, order, nil
}

func taskID(r *http.Request) (int64, error) {
	raw := strings.TrimSpace(r.URL.Query().Get("id"))
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		return 0, fmt.Errorf("invalid id")
	}
	return id, nil
}
