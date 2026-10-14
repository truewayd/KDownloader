package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"truedown/internal/downloader"
	"truedown/internal/systemupdate"
)

func TestUpdateProxyFollowsCurrentManagerAndFailsClosedWhenUnavailable(t *testing.T) {
	request, _ := http.NewRequest(http.MethodGet, "https://github.com/update.bin", nil)
	host := &managerHost{}
	if _, err := host.proxyForRequest(request); err == nil {
		t.Fatal("updater bypassed saved settings with no manager")
	}
	for _, mode := range []string{"custom", "none", "custom"} {
		root := t.TempDir()
		manager, err := downloader.NewManager("unused", root, filepath.Join(root, "records.db"))
		if err != nil {
			t.Fatal(err)
		}
		defer manager.Stop()
		current := manager.TaskDefaults()
		values := current.Values
		values.ProxyMode, values.Proxy = mode, "https://127.0.0.1:7890"
		if _, err := manager.SetTaskDefaults(current.Revision, values); err != nil {
			t.Fatal(err)
		}
		host.current = &managerRuntime{manager: manager}
		proxy, err := host.proxyForRequest(request)
		if err != nil || (mode == "none" && proxy != nil) || (mode == "custom" && (proxy == nil || proxy.String() != values.Proxy)) {
			t.Fatal("updater retained a previous manager's proxy choice")
		}
	}
}

func TestBackgroundUpdateAdmissionOwnsLifetimeAndRejectsDuplicates(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("NEXT installation is Windows-only")
	}
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
	}))
	defer server.Close()
	root := t.TempDir()
	updates, err := systemupdate.New(systemupdate.Options{
		BaseDir: root, DataDir: root, StableEnginePath: filepath.Join(root, "aria2c.exe"),
		AllowInsecureLoopback: true, NextReleaseURL: server.URL,
		InspectEngine: func(string) (string, string, error) { return systemupdate.EngineStable, "1.37.0", nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	controller := newEngineController(updates, &managerHost{}, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	controller.updateContext = ctx
	snapshot, err := controller.StartUpdate("next-engine")
	if err != nil || snapshot.Busy != "next-engine" {
		t.Fatal("update was not accepted immediately", snapshot, err)
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("background check did not start")
	}
	if _, err := controller.StartUpdate("next-engine"); err == nil {
		t.Fatal("duplicate background update was admitted")
	}
	cancel()
	controller.waitUpdates()
	if _, err := controller.StartUpdate("next-engine"); err == nil {
		t.Fatal("update admitted during shutdown")
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		state := controller.Snapshot()
		if state.Busy == "" {
			if state.Error == "" {
				t.Fatal("cancelled operation reported success")
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("application cancellation did not stop the background update")
}
