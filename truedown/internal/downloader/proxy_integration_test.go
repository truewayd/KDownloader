package downloader

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestNativeTransfersUseSavedProxyAndKeepLocalRelayDirect(t *testing.T) {
	if os.Getenv("TRUEDOWN_INTEGRATION") != "1" {
		t.Skip("requires a native aria2 integration engine")
	}
	engine, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	payload := bytes.Repeat([]byte("native proxy fixture"), 128)
	var proxyHits atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxyHits.Add(1)
		if r.URL.Host != "proxy-choice.invalid" {
			t.Error("proxy captured traffic outside the external fixture")
		}
		http.ServeContent(w, r, "fixture.bin", time.Unix(1000, 0), bytes.NewReader(payload))
	}))
	defer proxy.Close()
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeContent(w, r, "fixture.bin", time.Unix(1000, 0), bytes.NewReader(payload))
	}))
	defer local.Close()
	root := t.TempDir()
	m, err := NewManagerWithConfig(engine, root, filepath.Join(root, "records.db"), integrationManagerConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	current := m.TaskDefaults()
	values := current.Values
	values.ProxyMode, values.Proxy = "custom", proxy.URL
	if _, err := m.SetTaskDefaults(current.Revision, values); err != nil {
		t.Fatal(err)
	}
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	ordinary, _, err := m.AddTask("http://proxy-choice.invalid/file.bin", "ordinary.bin", root, nil, "", 0, Aria2Opts{Connections: 1})
	if err != nil {
		t.Fatal(err)
	}
	waitForStatus(t, m, ordinary.ID, 15*time.Second, StatusDone)
	completed, _ := m.GetTask(ordinary.ID)
	data, err := os.ReadFile(filepath.Join(completed.Folder, completed.OutputName))
	if err != nil || !bytes.Equal(data, payload) || proxyHits.Load() == 0 {
		t.Fatal("native ordinary download bypassed the proxy or changed its bytes", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	for index, link := range []string{"http://proxy-choice.invalid/update.bin", local.URL + "/relay.bin"} {
		before := proxyHits.Load()
		path, err := m.DownloadUpdate(ctx, link, "update.bin", root, int64(len(payload)), Aria2Opts{Connections: 1, ProxyMode: "none"})
		if err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(data, payload) {
			t.Fatal("native update bytes changed", err)
		}
		if (index == 0 && proxyHits.Load() == before) || (index == 1 && proxyHits.Load() != before) {
			t.Fatal("native update did not distinguish upstream proxy traffic from its local relay")
		}
	}
}
