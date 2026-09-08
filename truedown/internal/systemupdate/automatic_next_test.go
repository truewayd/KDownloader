package systemupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
)

func TestAutomaticNextVerifiesNewerReleaseAndRetainsRollback(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("NEXT assets are Windows-only")
	}
	root := t.TempDir()
	stable := filepath.Join(root, "aria2c.exe")
	if err := os.WriteFile(stable, []byte("stable"), 0700); err != nil {
		t.Fatal(err)
	}
	var version atomic.Value
	version.Store("2.9.0")
	var downloads atomic.Int32
	arch := "x86_64"
	if runtime.GOARCH == "arm64" {
		arch = "arm64"
	}
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		v := version.Load().(string)
		binary := []byte("MZ-next-" + v)
		asset := fmt.Sprintf("aria2-next-%s-windows-%s.exe", v, arch)
		checksum := sha256Hex(binary) + "  " + asset + "\n"
		switch r.URL.Path {
		case "/release":
			_ = json.NewEncoder(w).Encode(githubRelease{TagName: "v" + v, Assets: []githubAsset{{Name: asset, Size: int64(len(binary)), BrowserDownloadURL: server.URL + "/binary"}, {Name: "aria2-next-" + v + "-checksums.sha256", Size: int64(len(checksum)), BrowserDownloadURL: server.URL + "/checksum"}}})
		case "/binary":
			downloads.Add(1)
			_, _ = w.Write(binary)
		case "/checksum":
			_, _ = w.Write([]byte(checksum))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	options := Options{NextReleaseURL: server.URL + "/release", AllowInsecureLoopback: true, InspectEngine: func(path string) (string, string, error) {
		data, err := os.ReadFile(path)
		if err != nil {
			return "", "", err
		}
		if strings.HasPrefix(string(data), "MZ-next-") {
			return EngineNext, strings.TrimPrefix(string(data), "MZ-next-"), nil
		}
		return EngineStable, "1.37.0", nil
	}}
	m := newTestManager(t, root, stable, options)
	if err := m.UpdateNextAutomatically(context.Background()); err != nil || downloads.Load() != 0 {
		t.Fatal("automatic updates installed an unrequested engine", err)
	}
	if _, err := m.InstallNext(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := m.SelectEngine(EngineNext); err != nil {
		t.Fatal(err)
	}
	old, err := m.PreferredEngine()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.ActivateEngine(old); err != nil {
		t.Fatal(err)
	}
	version.Store("2.10.0")
	if err := m.UpdateNextAutomatically(context.Background()); err != nil {
		t.Fatal(err)
	}
	state := m.Snapshot()
	if state.Engine.NextInstalledVersion != "2.10.0" || state.Engine.ActiveVersion != "2.9.0" || !state.Engine.RestartRequired {
		t.Fatal(state)
	}
	version.Store("2.10.1")
	if err := m.UpdateNextAutomatically(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := m.RestorePreviousNext(old); err != nil {
		t.Fatal(err)
	}
	if err := m.UpdateNextAutomatically(context.Background()); err != nil || downloads.Load() != 3 {
		t.Fatal("failed version was retried automatically", err, downloads.Load())
	}
	disabled := false
	if _, err := m.SetSettings(Settings{AutoUpdateNext: &disabled}); err != nil {
		t.Fatal(err)
	}
	version.Store("2.11.0")
	if err := m.UpdateNextAutomatically(context.Background()); err != nil || downloads.Load() != 3 {
		t.Fatal("disabled updates downloaded", err)
	}
	reloaded := newTestManager(t, root, stable, options)
	if reloaded.Snapshot().Engine.AutoUpdate || reloaded.Snapshot().Engine.NextInstalledVersion != "2.9.0" {
		t.Fatal("rollback or toggle was not durable")
	}
	if !reloaded.Snapshot().TrueDown.AutoUpdate {
		t.Fatal("NEXT preference changed program update preference")
	}
}
