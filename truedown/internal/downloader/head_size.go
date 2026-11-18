package downloader

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"time"

	"truedown/internal/netproxy"
)

func (m *Manager) shouldProbeHTTPSize(task *Task, torrent bool) bool {
	return task.TotalLength == 0 && !torrent && !isMediaTask(task) && !task.UpdateDownload &&
		(task.ModuleID == "" || task.ModuleID == TelegraphModuleID) &&
		m.taskDefaults != nil && m.TaskDefaults().Values.UseHead
}

func (m *Manager) startHTTPSizeProbe(snapshot *Task, torrent bool) {
	if !m.shouldProbeHTTPSize(snapshot, torrent) || m.lifecycleCtx.Err() != nil {
		return
	}
	if m.headReads.Add(1) > 4 {
		m.headReads.Add(-1)
		return
	}
	m.mu.Lock()
	task := m.tasks[snapshot.ID]
	if task == nil || task.TotalLength != 0 || (task.Status != StatusQueued && task.Status != StatusDownloading) {
		m.mu.Unlock()
		m.headReads.Add(-1)
		return
	}
	// The pointer identifies this admission, including retries that reuse a GID.
	pending := new(int64)
	task.headSize = pending
	m.mu.Unlock()
	m.wg.Go(func() {
		defer m.headReads.Add(-1)
		size := probeHTTPSize(m.lifecycleCtx, snapshot, m.proxyForTask(snapshot.Opts))
		if size <= 0 || m.lifecycleCtx.Err() != nil || !m.TaskDefaults().Values.UseHead {
			return
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		current := m.tasks[snapshot.ID]
		if current == nil || current.GID != snapshot.GID || current.RequestJSON != snapshot.RequestJSON ||
			current.headSize != pending || current.TotalLength != 0 || !m.ariaAdmitted[current.ID] ||
			(current.Status != StatusQueued && current.Status != StatusDownloading) {
			return
		}
		current.headSize = &size
		m.touchTaskLocked(current)
	})
}

func (task *Task) sizeHint() int64 {
	if task.TotalLength == 0 && task.headSize != nil && (task.Status == StatusQueued ||
		task.Status == StatusDownloading || task.Status == StatusPaused) {
		return *task.headSize
	}
	return 0
}

func (task *Task) displaySize() int64 {
	return max(task.TotalLength, task.sizeHint())
}

// A HEAD result is a best-effort size hint. The transfer response remains
// authoritative and a rejected HEAD does not change admission.
func probeHTTPSize(ctx context.Context, task *Task, proxy func(*http.Request) (*url.URL, error)) int64 {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodHead, task.Link, nil)
	if err != nil {
		return 0
	}
	options := ariaOptions(task, false)
	if headers, ok := options["header"].([]string); ok {
		for _, line := range headers {
			name, value, found := strings.Cut(line, ":")
			if !found {
				continue
			}
			switch strings.ToLower(name) {
			case "accept-encoding", "content-length", "host", "range", "proxy-authorization":
				continue
			}
			request.Header.Add(name, strings.TrimSpace(value))
		}
	}
	for option, header := range map[string]string{"referer": "Referer", "user-agent": "User-Agent"} {
		if value, ok := options[option].(string); ok && request.Header.Get(header) == "" {
			request.Header.Set(header, value)
		}
	}
	request.Header.Set("Accept-Encoding", "identity")
	transport := netproxy.NewTransport(proxy)
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport: transport,
		CheckRedirect: func(next *http.Request, via []*http.Request) error {
			// Task headers and the referrer are scoped to the original origin.
			if len(via) >= 5 || next.URL.User != nil || next.URL.Scheme != request.URL.Scheme ||
				!strings.EqualFold(next.URL.Host, request.URL.Host) {
				return http.ErrUseLastResponse
			}
			return nil
		},
	}
	response, err := client.Do(request)
	if err != nil {
		return 0
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.ContentLength <= 0 {
		return 0
	}
	if encoding := response.Header.Get("Content-Encoding"); encoding != "" && !strings.EqualFold(encoding, "identity") {
		return 0
	}
	return response.ContentLength
}
