package systemupdate

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// The engine owns scheduling and progress. This one-asset loopback endpoint
// keeps every upstream redirect and byte under the updater's network policy.
func (m *Manager) downloadQueuedAsset(ctx context.Context, rawURL, name, directory string, maximum int64) (string, string, int64, error) {
	if err := m.validateURL(rawURL); err != nil {
		return "", "", 0, err
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return "", "", 0, err
	}
	defer listener.Close()
	var token [32]byte
	if _, err := rand.Read(token[:]); err != nil {
		return "", "", 0, err
	}
	path := "/update/" + hex.EncodeToString(token[:])
	slots := make(chan struct{}, 8)
	server := &http.Server{ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 15 * time.Second,
		MaxHeaderBytes: 8192, ErrorLog: log.New(io.Discard, "", 0),
		BaseContext: func(net.Listener) context.Context { return ctx },
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Host != listener.Addr().String() || r.URL.Path != path || r.URL.RawQuery != "" || r.Method != http.MethodGet || r.Header.Get("Origin") != "" {
				http.NotFound(w, r)
				return
			}
			select {
			case slots <- struct{}{}:
				defer func() { <-slots }()
			default:
				http.Error(w, "Busy", 503)
				return
			}
			request, err := m.newRequest(r.Context(), rawURL)
			if err != nil {
				http.Error(w, "Invalid update URL", 502)
				return
			}
			if value := r.Header.Get("Range"); value != "" {
				if !boundedAssetRange(value, maximum) {
					http.Error(w, "Invalid range", 416)
					return
				}
				request.Header.Set("Range", value)
				request.Header.Set("If-Range", r.Header.Get("If-Range"))
			}
			response, err := m.client.Do(request)
			if err != nil {
				http.Error(w, "Update server unavailable", 502)
				return
			}
			defer response.Body.Close()
			if (response.StatusCode != 200 && response.StatusCode != 206) || response.ContentLength > maximum {
				http.Error(w, "Invalid update response or size", 502)
				return
			}
			if response.StatusCode == 206 {
				parts := strings.Split(response.Header.Get("Content-Range"), "/")
				if len(parts) != 2 {
					http.Error(w, "Invalid update range", 502)
					return
				}
				total, err := strconv.ParseInt(parts[1], 10, 64)
				if err != nil || total <= 0 || total > maximum {
					http.Error(w, "Invalid update size", 502)
					return
				}
			}
			for _, key := range []string{"Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified"} {
				if value := response.Header.Get(key); value != "" {
					w.Header().Set(key, value)
				}
			}
			w.Header().Set("Content-Type", "application/octet-stream")
			w.WriteHeader(response.StatusCode)
			_, copyErr := io.Copy(w, io.LimitReader(response.Body, maximum))
			var extra [1]byte
			count, readErr := response.Body.Read(extra[:])
			if copyErr != nil || count != 0 || (readErr != nil && readErr != io.EOF) {
				panic(http.ErrAbortHandler)
			}
		}),
	}
	go server.Serve(listener)
	defer server.Close()
	stop := context.AfterFunc(ctx, func() { _ = server.Close() })
	defer stop()
	filePath, err := m.downloadAsset(ctx, "http://"+listener.Addr().String()+path, name, directory, maximum)
	if err != nil {
		return "", "", 0, err
	}
	file, err := os.Open(filePath)
	if err != nil {
		os.Remove(filePath)
		return "", "", 0, err
	}
	hash := sha256.New()
	size, err := io.Copy(hash, io.LimitReader(file, maximum+1))
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil && size > maximum {
		err = fmt.Errorf("update download exceeds the allowed size")
	}
	if err != nil {
		os.Remove(filePath)
		return "", "", 0, err
	}
	return filePath, hex.EncodeToString(hash.Sum(nil)), size, nil
}

func boundedAssetRange(value string, maximum int64) bool {
	if !strings.HasPrefix(value, "bytes=") {
		return false
	}
	parts := strings.Split(strings.TrimPrefix(value, "bytes="), "-")
	if len(parts) != 2 {
		return false
	}
	start, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || start < 0 || start >= maximum {
		return false
	}
	if parts[1] == "" {
		return true
	}
	end, err := strconv.ParseInt(parts[1], 10, 64)
	return err == nil && end >= start && end < maximum
}
