package api

import (
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"truedown/internal/downloader"
)

const maxStartRequestBytes = 1024 * 1024

type downloadSourceReq struct {
	Link         string            `json:"link"`
	Headers      map[string]string `json:"headers"`
	DownloadPage string            `json:"downloadPage"`
}

type startReq struct {
	DownloadSource downloadSourceReq    `json:"downloadSource"`
	Folder         string               `json:"folder"`
	Name           string               `json:"name"`
	QueueID        int                  `json:"queueId"`
	Opts           downloader.Aria2Opts `json:"opts"`
}

func Register(mux *http.ServeMux, dm *downloader.Manager) {
	mux.HandleFunc("/start-headless-download", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || mediaType != "application/json" {
			http.Error(w, "content type must be application/json", http.StatusUnsupportedMediaType)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxStartRequestBytes)
		var req startReq
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&req); err != nil {
			http.Error(w, "invalid JSON request", http.StatusBadRequest)
			return
		}
		if err := decoder.Decode(&struct{}{}); err != io.EOF {
			http.Error(w, "request must contain one JSON object", http.StatusBadRequest)
			return
		}
		if req.DownloadSource.Link == "" {
			http.Error(w, "downloadSource.link is required", http.StatusBadRequest)
			return
		}
		t, duplicate, err := dm.AddTask(
			req.DownloadSource.Link,
			req.Name,
			req.Folder,
			req.DownloadSource.Headers,
			req.DownloadSource.DownloadPage,
			req.QueueID,
			req.Opts,
		)
		if err != nil {
			status := http.StatusInternalServerError
			if downloader.IsValidationError(err) {
				status = http.StatusBadRequest
			}
			http.Error(w, err.Error(), status)
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

	mux.HandleFunc("/tasks", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		tasks := dm.ListTaskSnapshots()
		sort.Slice(tasks, func(i, j int) bool {
			return tasks[i].ID < tasks[j].ID
		})
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if err := json.NewEncoder(w).Encode(tasks); err != nil {
			http.Error(w, "failed to encode task list", http.StatusInternalServerError)
		}
	})

	// POST /tasks/{id}/requeue — re-enqueue a failed task
	mux.HandleFunc("/tasks/requeue", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
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
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		n := dm.ClearDone()
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("OK " + strconv.Itoa(n)))
	})
}

func taskID(r *http.Request) (int64, error) {
	raw := strings.TrimSpace(r.URL.Query().Get("id"))
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		return 0, fmt.Errorf("invalid id")
	}
	return id, nil
}
