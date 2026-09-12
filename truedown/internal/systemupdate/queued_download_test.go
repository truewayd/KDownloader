package systemupdate

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"truedown/internal/downloader"
)

func TestQueuedAssetKeepsUpstreamPolicyAndBounds(t *testing.T) {
	payload := []byte("verified update bytes")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/redirect":
			http.Redirect(w, r, "https://untrusted.invalid/file", 302)
		case "/large":
			w.Header().Set("Content-Length", "100000")
			w.WriteHeader(200)
		case "/chunked":
			w.(http.Flusher).Flush()
			_, _ = w.Write(bytes.Repeat([]byte("x"), 65))
		case "/short":
			w.Header().Set("Content-Length", "10")
			_, _ = w.Write([]byte("xx"))
		default:
			http.ServeContent(w, r, "update.zip", time.Unix(1, 0), bytes.NewReader(payload))
		}
	}))
	defer upstream.Close()
	root := t.TempDir()
	var endpoint string
	m := newTestManager(t, root, filepath.Join(root, "aria2c.exe"), Options{AllowInsecureLoopback: true,
		DownloadAsset: func(ctx context.Context, url, name, directory string, maximum int64) (string, error) {
			endpoint = url
			for _, suffix := range []string{"?url=https://untrusted.invalid", "/other"} {
				response, err := http.Get(url + suffix)
				if err != nil {
					return "", err
				}
				response.Body.Close()
				if response.StatusCode != 404 {
					t.Errorf("relay accepted arbitrary target: %s", suffix)
				}
			}
			request, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
			request.Header.Set("Range", "bytes=0-")
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				return "", err
			}
			defer response.Body.Close()
			if response.StatusCode != 206 && response.StatusCode != 200 {
				return "", fmt.Errorf("download failed: %d", response.StatusCode)
			}
			file, err := os.CreateTemp(directory, "test-update-")
			if err != nil {
				return "", err
			}
			_, err = io.Copy(file, response.Body)
			file.Close()
			return file.Name(), err
		},
	})
	path, digest, size, err := m.downloadFile(context.Background(), upstream.URL+"/file", "update.zip", root, 64)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(path)
	if digest != sha256Hex(payload) || size != int64(len(payload)) {
		t.Fatal("queued output was not hashed correctly")
	}
	if response, err := http.Get(endpoint); err == nil {
		response.Body.Close()
		t.Fatal("completed relay remained available")
	}
	for _, target := range []string{upstream.URL + "/redirect", upstream.URL + "/large", upstream.URL + "/chunked", upstream.URL + "/short", "https://untrusted.invalid/file"} {
		if _, _, _, err := m.downloadFile(context.Background(), target, "update.zip", root, 64); err == nil {
			t.Errorf("accepted %s", target)
		}
	}
	for _, value := range []string{"bytes=-1", "bytes=1-0", "bytes=64-", "bytes=0-64", "bytes=0-1,3-4"} {
		if boundedAssetRange(value, 64) {
			t.Errorf("accepted unbounded range %q", value)
		}
	}
}

func TestQueuedAssetRealEngineProgressAndPause(t *testing.T) {
	if os.Getenv("TRUEDOWN_INTEGRATION") == "" {
		t.Skip("set TRUEDOWN_INTEGRATION=1 for real aria2")
	}
	engine := os.Getenv("TRUEDOWN_ARIA2_PATH")
	if engine == "" {
		t.Fatal("set TRUEDOWN_ARIA2_PATH")
	}
	payload := bytes.Repeat([]byte("update-payload"), 100000)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeContent(w, r, "update.zip", time.Unix(1, 0), bytes.NewReader(payload))
	}))
	defer upstream.Close()
	root := t.TempDir()
	dm, err := downloader.NewManager(engine, filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer dm.Stop()
	if err := dm.Start(); err != nil {
		t.Fatal(err)
	}
	m := newTestManager(t, root, engine, Options{AllowInsecureLoopback: true,
		DownloadAsset: func(ctx context.Context, url, name, directory string, maximum int64) (string, error) {
			return dm.DownloadUpdate(ctx, url, name, directory, maximum, downloader.Aria2Opts{Connections: 1, MaxSpeedBps: 256 * 1024, ProxyMode: "none"})
		},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	finished := make(chan error, 1)
	go func() {
		path, digest, size, err := m.downloadFile(ctx, upstream.URL+"/file", "update.zip", root, int64(len(payload)))
		if path != "" {
			defer os.Remove(path)
		}
		if err == nil && (digest != sha256Hex(payload) || size != int64(len(payload))) {
			err = fmt.Errorf("staged output differs")
		}
		finished <- err
	}()
	paused := false
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case err := <-finished:
			if err != nil {
				t.Fatal(err)
			}
			if !paused {
				t.Fatal("no observable progress before completion")
			}
			tasks := dm.ListTasks()
			if len(tasks) != 1 || tasks[0].Status != downloader.StatusDone {
				t.Fatal("update not retained as completed task")
			}
			data, err := os.ReadFile(filepath.Join(tasks[0].Folder, tasks[0].OutputName))
			if err != nil || !bytes.Equal(data, payload) {
				t.Fatal("task output was consumed by staging", err)
			}
			return
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-ticker.C:
			for _, task := range dm.ListTasks() {
				if paused || task.Status != downloader.StatusDownloading || task.CompletedLength == 0 {
					continue
				}
				if err := dm.PauseTask(task.ID); err != nil {
					t.Fatal(err)
				}
				state, _ := dm.GetTask(task.ID)
				if state.Status != downloader.StatusPaused {
					t.Fatal("update pause not visible")
				}
				if err := dm.ResumeTask(task.ID); err != nil {
					t.Fatal(err)
				}
				paused = true
			}
		}
	}
}
