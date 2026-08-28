package systemupdate

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestManualNextInstallPersistsSelection(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows assets are intentionally platform-specific")
	}
	root := t.TempDir()
	stablePath := filepath.Join(root, "aria2c.exe")
	if err := os.WriteFile(stablePath, []byte("stable"), 0700); err != nil {
		t.Fatal(err)
	}
	nextBinary := []byte("MZ-next-2.5.6")
	nextDigest := sha256Hex(nextBinary)
	architecture := "x86_64"
	if runtime.GOARCH == "arm64" {
		architecture = "arm64"
	}
	assetName := "aria2-next-2.5.6-windows-" + architecture + ".exe"
	checksumName := "aria2-next-2.5.6-checksums.sha256"
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/release":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"tag_name": "v2.5.6", "draft": false, "prerelease": false, "ignored": true,
				"assets": []map[string]any{
					{"name": assetName, "size": len(nextBinary), "browser_download_url": server.URL + "/next.exe"},
					{"name": checksumName, "size": len(nextDigest) + len(assetName) + 3, "browser_download_url": server.URL + "/checksums"},
				},
			})
		case "/next.exe":
			_, _ = w.Write(nextBinary)
		case "/checksums":
			_, _ = w.Write([]byte(nextDigest + "  " + assetName + "\n"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	manager := newTestManager(t, root, stablePath, Options{
		NextReleaseURL:        server.URL + "/release",
		AllowInsecureLoopback: true,
		InspectEngine: func(path string) (string, string, error) {
			data, err := os.ReadFile(path)
			if err != nil {
				return "", "", err
			}
			if bytes.Equal(data, nextBinary) {
				return EngineNext, "2.5.6", nil
			}
			return EngineStable, "1.37.0", nil
		},
	})
	if _, err := manager.SelectEngine(EngineNext); err == nil {
		t.Fatal("selecting NEXT before installation unexpectedly succeeded")
	}
	snapshot, err := manager.InstallNext(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Engine.Preference != EngineStable || !snapshot.Engine.NextInstalled || snapshot.Engine.RestartRequired {
		t.Fatalf("unexpected installed engine state: %+v", snapshot.Engine)
	}
	if snapshot.Engine.ManualUpdatesOnly != true {
		t.Fatal("NEXT must remain manual-update-only")
	}

	selected, err := manager.SelectEngine(EngineNext)
	if err != nil || selected.Engine.Preference != EngineNext || !selected.Engine.RestartRequired {
		t.Fatalf("explicit NEXT selection did not require a restart: snapshot=%+v err=%v", selected.Engine, err)
	}
	reloaded := newTestManager(t, root, stablePath, Options{
		NextReleaseURL:        server.URL + "/release",
		AllowInsecureLoopback: true,
		InspectEngine:         manager.inspectEngine,
	})
	if reloaded.Snapshot().Engine.Active != EngineNext || reloaded.EnginePath() == stablePath {
		t.Fatalf("reloaded manager did not activate the verified NEXT engine: %+v", reloaded.Snapshot().Engine)
	}
	stable, err := reloaded.SelectEngine(EngineStable)
	if err != nil || stable.Engine.Preference != EngineStable || !stable.Engine.RestartRequired {
		t.Fatalf("stable selection did not persist a restart requirement: snapshot=%+v err=%v", stable.Engine, err)
	}
}

func TestTrueDownUpdateStagesOnlyVerifiedExecutable(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("packaged self-updates are Windows-only")
	}
	root := t.TempDir()
	stablePath := filepath.Join(root, "aria2c.exe")
	if err := os.WriteFile(stablePath, []byte("stable"), 0700); err != nil {
		t.Fatal(err)
	}
	executable := []byte("MZ-fake-TrueDown-build-12")
	archive := makeReleaseArchive(t, executable)
	archiveDigest := sha256Hex(archive)
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		manifest := updateManifest{SchemaVersion: 1, Product: "TrueDown", Repository: "truewayd/KDownloader", Version: "truedown-build-12", Build: 12}
		manifest.Asset.Name = "TrueDown-build-12.zip"
		manifest.Asset.Size = int64(len(archive))
		manifest.Asset.SHA256 = archiveDigest
		manifestData, _ := json.Marshal(manifest)
		switch r.URL.Path {
		case "/releases":
			_ = json.NewEncoder(w).Encode([]map[string]any{{
				"tag_name": "truedown-build-12", "draft": false, "prerelease": false, "unknown": "accepted",
				"html_url": server.URL + "/release-page", "published_at": "2026-08-20T00:00:00Z",
				"assets": []map[string]any{
					{"name": "TrueDown-build-12.zip", "size": len(archive), "browser_download_url": server.URL + "/archive"},
					{"name": "truedown-update-12.json", "size": len(manifestData), "browser_download_url": server.URL + "/manifest"},
				},
			}})
		case "/manifest":
			_, _ = w.Write(manifestData)
		case "/archive":
			_, _ = w.Write(archive)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	manager := newTestManager(t, root, stablePath, Options{
		CurrentVersion:        "truedown-build-10",
		CurrentBuild:          10,
		TrueDownReleasesURL:   server.URL + "/releases",
		AllowInsecureLoopback: true,
	})
	snapshot, err := manager.UpdateTrueDown(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !snapshot.TrueDown.RestartRequired || snapshot.TrueDown.PendingBuild != 12 || !snapshot.TrueDown.UpdateAvailable {
		t.Fatalf("unexpected staged update state: %+v", snapshot.TrueDown)
	}
	manager.mu.RLock()
	pending := *manager.state.PendingUpdate
	stagedPath, pathErr := manager.pendingUpdatePathLocked(&pending)
	manager.mu.RUnlock()
	if pathErr != nil {
		t.Fatal(pathErr)
	}
	data, err := os.ReadFile(stagedPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, executable) || pending.SHA256 != sha256Hex(executable) {
		t.Fatal("staged executable or its persisted digest did not match the verified archive")
	}
}

func TestSignalHealthyRequiresMatchingBoundedToken(t *testing.T) {
	path := filepath.Join(t.TempDir(), "health")
	token := strings.Repeat("ab", 24)
	t.Setenv(updateHealthFileEnv, path)
	t.Setenv(updateHealthTokenEnv, token)
	if err := SignalHealthyFromEnvironment(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(data)) != token {
		t.Fatal("health marker did not contain the transaction token")
	}
}

func TestInvalidUpdateStateFallsBackWithoutBlockingStartup(t *testing.T) {
	root := t.TempDir()
	stablePath := filepath.Join(root, "aria2c.exe")
	if err := os.WriteFile(stablePath, []byte("stable"), 0700); err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(root, "truedown.updates.json")
	if err := os.WriteFile(statePath, []byte(`{"schemaVersion":1,"enginePreference":"next","unexpected":true}`), 0600); err != nil {
		t.Fatal(err)
	}
	manager := newTestManager(t, root, stablePath, Options{})
	snapshot := manager.Snapshot()
	if snapshot.Engine.Active != EngineStable || !strings.Contains(snapshot.Error, "ignored invalid update settings") {
		t.Fatalf("invalid update state did not fail safely: %+v", snapshot)
	}
	if _, err := os.Stat(statePath); !os.IsNotExist(err) {
		t.Fatalf("invalid state was not moved aside: %v", err)
	}
	matches, err := filepath.Glob(statePath + ".invalid-*")
	if err != nil || len(matches) != 1 {
		t.Fatalf("invalid state preservation matches=%v err=%v", matches, err)
	}
}

func TestEngineStartupFailureFallsBackWithoutChangingPreference(t *testing.T) {
	root := t.TempDir()
	stablePath := filepath.Join(root, "aria2c.exe")
	if err := os.WriteFile(stablePath, []byte("stable"), 0700); err != nil {
		t.Fatal(err)
	}
	manager := newTestManager(t, root, stablePath, Options{})
	manager.mu.Lock()
	manager.state.EnginePreference = EngineNext
	manager.active = activeEngine{Kind: EngineNext, Version: "2.5.6", Path: filepath.Join(root, "engines", "next.exe")}
	manager.mu.Unlock()

	if path := manager.FallbackToStable(errors.New("exit status 28")); path != stablePath {
		t.Fatalf("fallback path=%q, want %q", path, stablePath)
	}
	snapshot := manager.Snapshot()
	if snapshot.Engine.Active != EngineStable || snapshot.Engine.Preference != EngineNext || !snapshot.Engine.RestartRequired {
		t.Fatalf("fallback snapshot=%+v", snapshot)
	}
	if !strings.Contains(snapshot.Error, "exit status 28") {
		t.Fatalf("fallback reason was not retained: %+v", snapshot)
	}
}

func TestPersistedStateOmitsZeroLastCheckedAt(t *testing.T) {
	root := t.TempDir()
	stablePath := filepath.Join(root, "aria2c.exe")
	if err := os.WriteFile(stablePath, []byte("stable"), 0700); err != nil {
		t.Fatal(err)
	}
	manager := newTestManager(t, root, stablePath, Options{})
	manager.mu.Lock()
	err := manager.persistLocked()
	manager.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "truedown.updates.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "lastCheckedAt") {
		t.Fatalf("zero lastCheckedAt was persisted: %s", data)
	}
}

func TestTamperedStagedUpdateIsDiscardedBeforeHelperLaunch(t *testing.T) {
	root := t.TempDir()
	stablePath := filepath.Join(root, "aria2c.exe")
	if err := os.WriteFile(stablePath, []byte("stable"), 0700); err != nil {
		t.Fatal(err)
	}
	manager := newTestManager(t, root, stablePath, Options{CurrentBuild: 10, CurrentVersion: "truedown-build-10"})
	updatesDir := filepath.Join(root, "updates")
	if err := os.MkdirAll(updatesDir, 0700); err != nil {
		t.Fatal(err)
	}
	stagedPath := filepath.Join(updatesDir, "TrueDown-build-11.exe")
	if err := os.WriteFile(stagedPath, []byte("MZ-tampered"), 0700); err != nil {
		t.Fatal(err)
	}
	manager.mu.Lock()
	manager.state.PendingUpdate = &pendingAppUpdate{
		Version: "truedown-build-11",
		Build:   11,
		File:    filepath.Base(stagedPath),
		SHA256:  strings.Repeat("0", 64),
	}
	if err := manager.persistLocked(); err != nil {
		manager.mu.Unlock()
		t.Fatal(err)
	}
	manager.mu.Unlock()
	if err := manager.LaunchPendingApply(nil); err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatalf("tampered staged update error=%v", err)
	}
	if manager.HasPendingUpdate() {
		t.Fatal("tampered staged update remained pending")
	}
	if _, err := os.Stat(stagedPath); !os.IsNotExist(err) {
		t.Fatalf("tampered staged executable was not removed: %v", err)
	}
}

func TestApplyTransactionReplacesExecutableAfterHealthSignal(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows executable replacement protocol")
	}
	root := t.TempDir()
	updatesDir := filepath.Join(root, "updates")
	if err := os.MkdirAll(updatesDir, 0700); err != nil {
		t.Fatal(err)
	}
	testExecutable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	targetPath := filepath.Join(root, "TrueDown.exe")
	stagedPath := filepath.Join(updatesDir, "TrueDown-build-2.exe")
	if err := copyExecutable(testExecutable, targetPath); err != nil {
		t.Fatal(err)
	}
	if err := copyExecutable(testExecutable, stagedPath); err != nil {
		t.Fatal(err)
	}
	digest, _, err := hashFile(stagedPath, maxExecutableBytes)
	if err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(root, "truedown.updates.json")
	state := persistedState{
		SchemaVersion:      stateSchemaVersion,
		AutoUpdateTrueDown: true,
		EnginePreference:   EngineStable,
		PendingUpdate: &pendingAppUpdate{
			Version: "truedown-build-2",
			Build:   2,
			File:    filepath.Base(stagedPath),
			SHA256:  digest,
		},
	}
	stateData, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeAtomicFile(statePath, stateData, 0600); err != nil {
		t.Fatal(err)
	}
	token := strings.Repeat("cd", 24)
	transaction := applyTransaction{
		SchemaVersion: applySchemaVersion,
		Build:         2,
		TargetPath:    targetPath,
		StagedPath:    stagedPath,
		BackupPath:    targetPath + ".previous",
		StatePath:     statePath,
		HealthPath:    filepath.Join(updatesDir, "health-2-test"),
		HealthToken:   token,
		ExpectedSHA:   digest,
		OriginalArgs:  []string{"-test.run=^TestUpdateHealthChild$"},
	}
	transactionData, err := json.Marshal(transaction)
	if err != nil {
		t.Fatal(err)
	}
	transactionPath := filepath.Join(updatesDir, "apply-2-test.json")
	if err := writeAtomicFile(transactionPath, transactionData, 0600); err != nil {
		t.Fatal(err)
	}
	if err := runApplyTransaction(transactionPath); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	var saved persistedState
	if err := json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.PendingUpdate != nil {
		t.Fatal("successful health-checked replacement remained pending")
	}
	if _, err := os.Stat(targetPath + ".previous"); err != nil {
		t.Fatalf("previous executable backup is missing: %v", err)
	}
	if _, err := os.Stat(stagedPath); !os.IsNotExist(err) {
		t.Fatalf("staged executable was not reclaimed: %v", err)
	}
	time.Sleep(900 * time.Millisecond)
}

func TestUpdateHealthChild(t *testing.T) {
	if !IsUpdateRelaunch() {
		t.Skip("only runs as the replacement child process")
	}
	if err := SignalHealthyFromEnvironment(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(600 * time.Millisecond)
}

func newTestManager(t *testing.T, root, stablePath string, overrides Options) *Manager {
	t.Helper()
	options := overrides
	options.BaseDir = root
	options.DataDir = root
	options.StableEnginePath = stablePath
	if options.InspectEngine == nil {
		options.InspectEngine = func(string) (string, string, error) { return EngineStable, "1.37.0", nil }
	}
	manager, err := New(options)
	if err != nil {
		t.Fatal(err)
	}
	return manager
}

func makeReleaseArchive(t *testing.T, executable []byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	archive := zip.NewWriter(&buffer)
	entry, err := archive.Create("TrueDown.exe")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := entry.Write(executable); err != nil {
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func sha256Hex(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}
