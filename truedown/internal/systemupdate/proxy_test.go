package systemupdate

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"truedown/internal/downloader"
)

func TestUpdateMetadataAndQueuedAssetFollowCurrentProxy(t *testing.T) {
	payload := "update fixture"
	var hits atomic.Int32
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.Host != "github.com" || r.Header.Get("Cookie") != "" || r.Header.Get("Referer") != "" {
			t.Error("updater request target or credential isolation changed")
		}
		_, _ = io.WriteString(w, payload)
	}))
	defer upstream.Close()
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect || r.Host != "github.com:443" {
			http.Error(w, "unexpected proxy target", http.StatusBadRequest)
			return
		}
		upstreamURL, _ := url.Parse(upstream.URL)
		remote, err := net.Dial("tcp", upstreamURL.Host)
		if err != nil {
			t.Error(err)
			return
		}
		defer remote.Close()
		connection, buffered, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer connection.Close()
		_, _ = buffered.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		_ = buffered.Flush()
		go func() { _, _ = io.Copy(remote, buffered); _ = remote.Close() }()
		_, _ = io.Copy(connection, remote)
	}))
	defer proxy.Close()
	root := t.TempDir()
	dm, err := downloader.NewManager("unused", root, filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer dm.Stop()
	manager := newTestManager(t, root, filepath.Join(root, "aria2c.exe"), Options{
		AllowInsecureLoopback: true,
		Proxy:                 dm.ProxyForRequest,
		DownloadAsset: func(ctx context.Context, link, name, directory string, maximum int64, progress func(DownloadProgress)) (string, error) {
			// Even with a custom upstream proxy, the queue reaches the relay directly.
			client := &http.Client{Transport: &http.Transport{Proxy: dm.ProxyForRequest}}
			defer client.CloseIdleConnections()
			response, err := client.Get(link)
			if err != nil {
				return "", err
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusOK {
				return "", io.ErrUnexpectedEOF
			}
			file, err := os.CreateTemp(directory, "update-")
			if err != nil {
				return "", err
			}
			_, err = io.Copy(file, response.Body)
			closeErr := file.Close()
			if err == nil {
				err = closeErr
			}
			return file.Name(), err
		},
	})
	defer manager.client.CloseIdleConnections()
	// Use a local TLS proxy CA and reject direct traffic in this offline fixture.
	transport := manager.client.Transport.(*http.Transport)
	transport.TLSClientConfig = upstream.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
	transport.TLSClientConfig.ServerName = "127.0.0.1"
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		proxyURL, _ := url.Parse(proxy.URL)
		if address != proxyURL.Host {
			return nil, fmt.Errorf("unexpected direct update connection")
		}
		return (&net.Dialer{}).DialContext(ctx, network, address)
	}
	for _, mode := range []string{"custom", "none", "custom"} {
		current := dm.TaskDefaults()
		values := current.Values
		values.ProxyMode, values.Proxy = mode, proxy.URL
		values.Headers = `{"Cookie":"private-cookie"}`
		values.Referer = "https://private.invalid"
		if _, err := dm.SetTaskDefaults(current.Revision, values); err != nil {
			t.Fatal(err)
		}
		before := hits.Load()
		data, fetchErr := manager.fetch(context.Background(), "https://github.com/metadata", 64)
		path, _, size, downloadErr := manager.downloadFile(context.Background(), "https://github.com/update.bin", "update.bin", root, 64)
		if mode == "none" {
			if fetchErr == nil || downloadErr == nil || hits.Load() != before {
				t.Fatal("no-proxy mode still reached the proxy")
			}
			continue
		}
		if fetchErr != nil || string(data) != payload || downloadErr != nil || size != int64(len(payload)) || hits.Load() != before+2 {
			t.Fatalf("metadata or asset bypassed the current proxy: %v %v", fetchErr, downloadErr)
		}
		os.Remove(path)
	}
}
