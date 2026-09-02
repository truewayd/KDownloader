package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"truedown/internal/downloader"
	"truedown/internal/systemupdate"
)

func TestDrainingHandlerWaitsForInflightRequestAndRejectsNewWork(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	handler := newDrainingHandler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		select {
		case <-entered:
		default:
			close(entered)
		}
		<-release
		w.WriteHeader(http.StatusNoContent)
	}))

	firstDone := make(chan struct{})
	go func() {
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/tasks", nil))
		close(firstDone)
	}()
	<-entered

	drainContext, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	drained := make(chan error, 1)
	go func() { drained <- handler.quiesce(drainContext) }()
	time.Sleep(10 * time.Millisecond)

	rejected := httptest.NewRecorder()
	handler.ServeHTTP(rejected, httptest.NewRequest(http.MethodGet, "/tasks", nil))
	if rejected.Code != http.StatusServiceUnavailable || rejected.Header().Get("Retry-After") == "" {
		t.Fatalf("request during drain status=%d headers=%v", rejected.Code, rejected.Header())
	}
	select {
	case err := <-drained:
		t.Fatalf("handler drained before inflight request completed: %v", err)
	default:
	}
	close(release)
	if err := <-drained; err != nil {
		t.Fatal(err)
	}
	<-firstDone
}

func TestAppendWithoutEnvironmentReplacesCaseInsensitively(t *testing.T) {
	result := appendWithoutEnvironment([]string{"A=1", "truedown_engine_relaunch=old", "B=2"}, engineRelaunchEnv)
	if len(result) != 2 || result[0] != "A=1" || result[1] != "B=2" {
		t.Fatalf("filtered environment=%v", result)
	}
}

func TestEngineRelaunchAttemptIsBounded(t *testing.T) {
	t.Setenv(engineRelaunchEnv, "1")
	if !isEngineRelaunch() || engineRelaunchAttempt() != 1 {
		t.Fatalf("relaunch attempt=%d", engineRelaunchAttempt())
	}
	t.Setenv(engineRelaunchEnv, "invalid")
	if isEngineRelaunch() || engineRelaunchAttempt() != 0 {
		t.Fatalf("invalid relaunch attempt=%d", engineRelaunchAttempt())
	}
}

func TestManagerHostRejectsStableTransitionWithActiveBitTorrent(t *testing.T) {
	root := t.TempDir()
	manager, err := downloader.NewManagerWithConfig(
		"unused",
		filepath.Join(root, "downloads"),
		filepath.Join(root, "records.db"),
		downloader.ManagerConfig{Aria2Next: true, Aria2NextVersion: "2.6.6"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := manager.AddBitTorrentLink("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567", root, nil, "", downloader.Aria2Opts{}); err != nil {
		manager.Stop()
		t.Fatal(err)
	}
	built := false
	host := &managerHost{}
	host.configure(
		manager,
		systemupdate.EngineSpec{Kind: systemupdate.EngineNext, Version: "2.6.6", Path: "next.exe", File: "next.exe"},
		func(systemupdate.EngineSpec) (*downloader.Manager, error) {
			built = true
			return nil, nil
		},
		func(*downloader.Manager) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
		},
	)
	defer host.stop()

	result, err := host.transition(nil, systemupdate.EngineSpec{Kind: systemupdate.EngineStable, Path: "aria2c.exe"}, nil, 1)
	if err == nil || result.TargetLive || built {
		t.Fatalf("stable transition result=%+v built=%v err=%v", result, built, err)
	}
	response := httptest.NewRecorder()
	host.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
	if response.Code != http.StatusNoContent {
		t.Fatalf("original runtime did not resume after rejected transition: %d", response.Code)
	}
}

func TestManagerHostRollsBackWhenSelectedEngineCannotStart(t *testing.T) {
	root := t.TempDir()
	newManager := func(name string) *downloader.Manager {
		manager, err := downloader.NewManager(
			"unused",
			filepath.Join(root, name+"-downloads"),
			filepath.Join(root, name+".db"),
		)
		if err != nil {
			t.Fatal(err)
		}
		return manager
	}
	stable := systemupdate.EngineSpec{Kind: systemupdate.EngineStable, Version: "1.37.0", Path: "aria2c.exe", File: "aria2c.exe"}
	next := systemupdate.EngineSpec{Kind: systemupdate.EngineNext, Version: "2.6.6", Path: "next.exe", File: "next.exe"}
	host := &managerHost{}
	host.configure(
		newManager("initial"),
		stable,
		func(systemupdate.EngineSpec) (*downloader.Manager, error) { return nil, nil },
		func(*downloader.Manager) http.Handler { return http.NewServeMux() },
	)
	host.launch = func(spec systemupdate.EngineSpec) (*downloader.Manager, error) {
		if spec.Kind == systemupdate.EngineNext {
			return nil, context.DeadlineExceeded
		}
		return newManager("rollback"), nil
	}
	defer host.stop()

	result, err := host.transition(nil, next, &stable, 1)
	if err == nil || !result.RolledBack || result.TargetLive || !sameRuntimeEngine(result.Active, stable) {
		t.Fatalf("rollback result=%+v err=%v", result, err)
	}
	host.mu.RLock()
	active := host.current
	host.mu.RUnlock()
	if active == nil || !sameRuntimeEngine(active.spec, stable) {
		t.Fatalf("active runtime after rollback=%+v", active)
	}
}
