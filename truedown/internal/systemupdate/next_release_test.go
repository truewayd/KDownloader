package systemupdate

import (
	"context"
	"encoding/json"
	"errors"
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

type nextPolicyFixture struct {
	manager   *Manager
	options   Options
	version   atomic.Value
	checksum  atomic.Value
	downloads atomic.Int32
}

func newNextPolicyFixture(t *testing.T) *nextPolicyFixture {
	t.Helper()
	f := &nextPolicyFixture{}
	f.version.Store("3.0.2")
	f.checksum.Store("")
	architecture := "x86_64"
	if runtime.GOARCH == "arm64" {
		architecture = "arm64"
	}
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		version := f.version.Load().(string)
		binary := []byte("MZ-next-" + version)
		asset := fmt.Sprintf("aria2-next-%s-windows-%s.exe", version, architecture)
		digest := f.checksum.Load().(string)
		if digest == "" {
			digest = sha256Hex(binary)
		}
		checksum := digest + "  " + asset + "\n"
		switch r.URL.Path {
		case "/release":
			_ = json.NewEncoder(w).Encode(githubRelease{TagName: "v" + version, Assets: []githubAsset{
				{Name: asset, Size: int64(len(binary)), BrowserDownloadURL: server.URL + "/binary"},
				{Name: "aria2-next-" + version + "-checksums.sha256", Size: int64(len(checksum)), BrowserDownloadURL: server.URL + "/checksum"},
			}})
		case "/checksum":
			_, _ = w.Write([]byte(checksum))
		case "/binary":
			f.downloads.Add(1)
			_, _ = w.Write(binary)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	f.options = Options{NextReleaseURL: server.URL + "/release", NextReleaseVersion: "3.0.2", NextReleaseSHA256: sha256Hex([]byte("MZ-next-3.0.2")), AllowInsecureLoopback: true,
		InspectEngine: func(path string) (string, string, error) {
			data, err := os.ReadFile(path)
			if err != nil {
				return "", "", err
			}
			if strings.HasPrefix(string(data), "MZ-next-") {
				return EngineNext, strings.TrimPrefix(string(data), "MZ-next-"), nil
			}
			return EngineStable, "1.37.0", nil
		}}
	root := t.TempDir()
	stable := filepath.Join(root, "aria2c.exe")
	if err := os.WriteFile(stable, []byte("stable"), 0700); err != nil {
		t.Fatal(err)
	}
	f.manager = newTestManager(t, root, stable, f.options)
	return f
}

func (f *nextPolicyFixture) saveEngine(t *testing.T, version string) *installedEngine {
	t.Helper()
	binary := []byte("MZ-next-" + version)
	engine := &installedEngine{Version: version, File: "aria2-next-" + version + "-windows-x86_64.exe", SHA256: sha256Hex(binary)}
	if err := os.MkdirAll(f.manager.enginesDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.manager.enginesDir, engine.File), binary, 0700); err != nil {
		t.Fatal(err)
	}
	return engine
}

func (f *nextPolicyFixture) prepareRollback(t *testing.T) {
	t.Helper()
	m := f.manager
	next := m.state
	next.EnginePreference = EngineNext
	next.NextEngine, next.PreviousNextEngine = f.saveEngine(t, "3.0.2"), f.saveEngine(t, "3.0.0")
	if err := m.persistStateLocked(next); err != nil {
		t.Fatal(err)
	}
	active, err := m.PreferredEngine()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.ActivateEngine(active); err != nil {
		t.Fatal(err)
	}
}

func TestDefaultNextReleaseFollowsReviewedBuildPolicy(t *testing.T) {
	policy, err := reviewedNextRelease()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	m := newTestManager(t, root, filepath.Join(root, "aria2c.exe"), Options{})
	if m.nextReleaseURL != defaultNextReleaseURL+policy.Version || m.Snapshot().Engine.NextRecommendedVersion != policy.Version || m.nextReleaseSHA256 != policy.Windows[runtime.GOARCH] {
		t.Fatal("updater did not bind discovery and checksums to its build's reviewed NEXT")
	}
}

func TestNextInstallRejectsUnreviewedReleaseOrChecksum(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("NEXT installation is Windows-only")
	}
	for _, reason := range []string{"version", "checksum"} {
		t.Run(reason, func(t *testing.T) {
			f := newNextPolicyFixture(t)
			if reason == "version" {
				f.version.Store("3.0.3")
			} else {
				f.checksum.Store(strings.Repeat("f", 64))
			}
			if _, err := f.manager.InstallNext(context.Background()); err == nil || f.downloads.Load() != 0 || f.manager.Snapshot().Engine.NextInstalled {
				t.Fatal("an unreviewed release reached binary download or installation", err)
			}
		})
	}
}

func TestNextRollbackPersistsAndRequiresExplicitRecommendedRestore(t *testing.T) {
	f := newNextPolicyFixture(t)
	f.prepareRollback(t)
	m := f.manager
	if m.Snapshot().Engine.NextRollbackVersion != "3.0.0" {
		t.Fatal("previous verified engine was not offered")
	}
	state, err := m.SelectEngine(EnginePreviousNext)
	if err != nil || state.Engine.Preference != EngineNext || state.Engine.NextInstalledVersion != "3.0.0" || state.Engine.NextBlockedVersion != "3.0.2" || !state.Engine.RestartRequired {
		t.Fatal("rollback selection failed", state, err)
	}
	if _, err := m.SelectEngine(EnginePreviousNext); err == nil {
		t.Fatal("rollback selection allowed an implicit upgrade")
	}
	preferred, err := m.PreferredEngine()
	if err != nil || preferred.Version != "3.0.0" {
		t.Fatal("rollback did not resolve the previous verified binary", preferred, err)
	}
	if _, err := m.ActivateEngine(preferred); err != nil {
		t.Fatal(err)
	}
	reloaded := newTestManager(t, m.baseDir, m.stableEnginePath, f.options)
	if reloaded.Snapshot().Engine.ActiveVersion != "3.0.0" || reloaded.Snapshot().Engine.NextBlockedVersion != "3.0.2" {
		t.Fatal("rollback was lost on restart")
	}
	if err := reloaded.UpdateNextAutomatically(context.Background()); err != nil || f.downloads.Load() != 0 {
		t.Fatal("automatic update undid rollback", err)
	}
	if runtime.GOOS == "windows" {
		state, err := reloaded.InstallNext(context.Background())
		if err != nil || state.Engine.NextInstalledVersion != "3.0.2" || state.Engine.NextBlockedVersion != "" || state.Engine.NextRollbackVersion != "3.0.0" {
			t.Fatal("explicit restore did not release the held recommendation", state, err)
		}
	}
}

func TestNextRollbackFailuresPreserveSelection(t *testing.T) {
	for _, reason := range []string{"missing", "checksum", "persistence"} {
		t.Run(reason, func(t *testing.T) {
			f := newNextPolicyFixture(t)
			f.prepareRollback(t)
			m := f.manager
			previous := filepath.Join(m.enginesDir, m.state.PreviousNextEngine.File)
			var err error
			switch reason {
			case "missing":
				err = os.Remove(previous)
			case "checksum":
				err = os.WriteFile(previous, []byte("changed"), 0700)
			case "persistence":
				m.statePath = t.TempDir()
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := m.SelectEngine(EnginePreviousNext); err == nil || m.Snapshot().Engine.NextInstalledVersion != "3.0.2" || m.state.NextFailedVersion != "" || m.ActiveEngine().Version != "3.0.2" {
				t.Fatal("failed rollback changed the durable selection or running engine", err)
			}
		})
	}
}

func TestProgramAndNextUpdateErrorsRemainIndependentAcrossRetryAndRestart(t *testing.T) {
	f := newNextPolicyFixture(t)
	m := f.manager
	if err := m.begin("truedown"); err != nil {
		t.Fatal(err)
	}
	m.finish(errors.New("program installation failed"))
	if err := m.begin("next-engine"); err != nil {
		t.Fatal(err)
	}
	m.finish(errors.New("engine verification failed"))
	state := m.Snapshot()
	if state.TrueDown.Error != "program installation failed" || state.Engine.Error != "engine verification failed" {
		t.Fatal("one updater's error replaced another's", state)
	}
	reloaded := newTestManager(t, m.baseDir, m.stableEnginePath, f.options)
	if reloaded.Snapshot().TrueDown.Error != state.TrueDown.Error || reloaded.Snapshot().Engine.Error != state.Engine.Error {
		t.Fatal("updater error ownership was lost on restart")
	}
	if err := reloaded.begin("next-engine"); err != nil {
		t.Fatal(err)
	}
	reloaded.finish(nil)
	if reloaded.Snapshot().Engine.Error != "" || reloaded.Snapshot().TrueDown.Error != state.TrueDown.Error {
		t.Fatal("retrying NEXT cleared the program failure")
	}
}

func TestUpdateEntrypointsClearOnlyTheirOwnFailure(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("program and NEXT installation are Windows-only")
	}
	f := newNextPolicyFixture(t)
	m := f.manager
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("[]"))
	}))
	defer server.Close()
	m.trueDownReleasesURL, m.currentBuild = server.URL, 1
	m.programUpdatesDisabled = false
	next := m.state
	next.LastUpdateError, next.NextUpdateError = "program installation failed", "engine verification failed"
	if err := m.persistStateLocked(next); err != nil {
		t.Fatal(err)
	}
	state, err := m.UpdateTrueDown(context.Background())
	if err != nil || state.TrueDown.Error != "" || state.Engine.Error != next.NextUpdateError {
		t.Fatal("program retry cleared the NEXT failure", state, err)
	}
	if err := m.begin("truedown"); err != nil {
		t.Fatal(err)
	}
	m.finish(errors.New(next.LastUpdateError))
	state, err = m.InstallNext(context.Background())
	if err != nil || state.TrueDown.Error != next.LastUpdateError || state.Engine.Error != "" || !state.Engine.NextInstalled {
		t.Fatal("NEXT installation cleared the program failure", state, err)
	}
}
