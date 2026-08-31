package downloader

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func dropboxUpdatePackage(version string) json.RawMessage {
	return json.RawMessage(`{
		"schemaVersion":1,
		"id":"dropbox",
		"engine":"dropbox-v1",
		"version":"` + version + `",
		"releasedAt":"2026-08-20",
		"config":{
			"folderEntriesPath":"/component-folder-entries",
			"csrfCookieNames":["component-csrf"],
			"userAgent":"TrueDown Dropbox component test"
		}
	}`)
}

func googleDriveUpdatePackage(version, stablePath string) json.RawMessage {
	return json.RawMessage(`{
		"schemaVersion":1,
		"id":"google-drive",
		"engine":"google-drive-v1",
		"version":"` + version + `",
		"releasedAt":"2026-08-20",
		"config":{
			"stableDownloadPath":"` + stablePath + `",
			"openPath":"/open-v2",
			"folderViewPath":"/embeddedfolderview-v2",
			"nativeExportPath":"/compat/{type}/d/{id}/export",
			"userAgent":"TrueDown component test"
		}
	}`)
}

func TestResolverComponentUpdateHotReloadsPersistsAndResets(t *testing.T) {
	root := t.TempDir()
	databasePath := filepath.Join(root, "records.db")
	manager, err := NewManager("unused", filepath.Join(root, "downloads"), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	oldModule := manager.modules.module(GoogleDriveModuleID).(*googleDriveResolverModule)
	if oldModule.profile.StableDownloadPath != "/uc" {
		t.Fatalf("unexpected baseline profile: %+v", oldModule.profile)
	}
	if _, err := manager.SetModuleInstalled(GoogleDriveModuleID, false); err != nil {
		t.Fatal(err)
	}

	updated, err := manager.InstallModulePackage(googleDriveUpdatePackage("1.1.0", "/uc-v2"))
	if err != nil {
		t.Fatal(err)
	}
	if updated.Version != "1.1.0" || updated.BaselineVersion != "1.0.0" ||
		updated.Source != "updated" || updated.Installed || !updated.HotReload || len(updated.Digest) != 64 {
		t.Fatalf("unexpected updated component info: %+v", updated)
	}
	newModule := manager.modules.module(GoogleDriveModuleID).(*googleDriveResolverModule)
	if newModule == oldModule || newModule.profile.StableDownloadPath != "/uc-v2" ||
		!strings.Contains(newModule.profile.stableLink("file-id-1234567890", "", ""), "/uc-v2?") {
		t.Fatalf("component was not hot-swapped: old=%+v new=%+v", oldModule.profile, newModule.profile)
	}
	if oldModule.profile.StableDownloadPath != "/uc" {
		t.Fatal("in-flight component snapshot was mutated")
	}
	if _, err := manager.InstallModulePackage(googleDriveUpdatePackage("1.1.0", "/same-version")); !IsValidationError(err) {
		t.Fatalf("same-version replacement error=%v", err)
	}
	manager.Stop()

	reopened, err := NewManager("unused", filepath.Join(root, "downloads"), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Stop()
	persisted := reopened.modules.module(GoogleDriveModuleID).(*googleDriveResolverModule)
	if persisted.profile.StableDownloadPath != "/uc-v2" {
		t.Fatalf("component update did not persist: %+v", persisted.profile)
	}
	for _, module := range reopened.Modules() {
		if module.ID == GoogleDriveModuleID && module.Installed {
			t.Fatal("component update changed the independently persisted enablement")
		}
	}
	baseline, err := reopened.ResetModulePackage(GoogleDriveModuleID)
	if err != nil {
		t.Fatal(err)
	}
	if baseline.Source != "baseline" || baseline.Version != baseline.BaselineVersion || baseline.Installed {
		t.Fatalf("unexpected reset component info: %+v", baseline)
	}
	if _, err := os.Stat(filepath.Join(root, "modules", GoogleDriveModuleID+".json")); !os.IsNotExist(err) {
		t.Fatalf("component update still exists after reset: %v", err)
	}
}

func TestResolverComponentInvalidInstalledUpdateFallsBackToBaseline(t *testing.T) {
	root := t.TempDir()
	modulesDir := filepath.Join(root, "modules")
	if err := os.MkdirAll(modulesDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(modulesDir, "dropbox.json"), []byte(`{"schemaVersion":1,"id":"dropbox"}`), 0600); err != nil {
		t.Fatal(err)
	}
	manager, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Stop()
	for _, module := range manager.Modules() {
		if module.ID == DropboxModuleID {
			if module.Source != "baseline" || module.UpdateError == "" || module.Version != "1.0.0" {
				t.Fatalf("invalid package did not fall back safely: %+v", module)
			}
			return
		}
	}
	t.Fatal("Dropbox component is missing")
}

func TestResolverComponentNullInstalledUpdateFallsBackToBaseline(t *testing.T) {
	root := t.TempDir()
	modulesDir := filepath.Join(root, "modules")
	if err := os.MkdirAll(modulesDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(modulesDir, "dropbox.json"), []byte("null\n"), 0600); err != nil {
		t.Fatal(err)
	}
	manager, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Stop()
	for _, module := range manager.Modules() {
		if module.ID == DropboxModuleID {
			if module.Source != "baseline" || !strings.Contains(module.UpdateError, "JSON object") {
				t.Fatalf("null package did not fail closed to the baseline: %+v", module)
			}
			return
		}
	}
	t.Fatal("Dropbox component is missing")
}

func TestResolverModuleSettingsRecoverFromAtomicWriteBackup(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(root, "truedown.modules.json.bak"),
		[]byte(`{"schemaVersion":1,"installed":{"dropbox":false,"google-drive":true}}`),
		0600,
	); err != nil {
		t.Fatal(err)
	}
	manager, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Stop()
	for _, module := range manager.Modules() {
		if module.ID == DropboxModuleID && module.Installed {
			t.Fatalf("Dropbox enablement did not recover from backup: %+v", module)
		}
	}
}

func TestDropboxComponentUpdateControlsFolderProtocolWithoutChangingHost(t *testing.T) {
	root := t.TempDir()
	manager, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Stop()
	if _, err := manager.InstallModulePackage(dropboxUpdatePackage("1.1.0")); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.SetDownloadRules(DownloadRules{DropboxMode: DropboxModeExpand}); err != nil {
		t.Fatal(err)
	}
	requests := 0
	manager.dropboxClient = &http.Client{
		Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			requests++
			if request.URL.Hostname() != "www.dropbox.com" || request.Header.Get("User-Agent") != "TrueDown Dropbox component test" {
				return nil, fmt.Errorf("unexpected component request: %s user-agent=%q", request.URL, request.Header.Get("User-Agent"))
			}
			if request.Method == http.MethodGet {
				return dropboxTestResponse(request, http.StatusOK, `<html></html>`, http.Header{
					"Set-Cookie": []string{"component-csrf=test; Path=/; Secure"},
				}), nil
			}
			if request.Method != http.MethodPost || request.URL.Path != "/component-folder-entries" {
				return nil, fmt.Errorf("unexpected component endpoint: %s %s", request.Method, request.URL)
			}
			return dropboxTestJSON(request, `{"folder":{"filename":"root","is_dir":true},"entries":[]}`), nil
		}),
	}
	result, handled, err := manager.AddWithModules(
		context.Background(), "https://www.dropbox.com/scl/fo/key/hash?dl=0", "", "", nil, "", 0, Aria2Opts{},
		nil,
	)
	if err != nil || !handled || !result.Collection || requests != 2 {
		t.Fatalf("updated Dropbox component handled=%v requests=%d result=%+v err=%v", handled, requests, result, err)
	}
	overridden, handled, err := manager.AddWithModules(
		context.Background(), "https://www.dropbox.com/scl/fo/key/hash?dl=0", "", "", nil, "", 0, Aria2Opts{},
		map[string]json.RawMessage{DropboxModuleID: json.RawMessage(`{"mode":"direct"}`)},
	)
	if err != nil || !handled || overridden.Collection || len(overridden.Tasks) != 1 || requests != 2 {
		t.Fatalf("explicit Dropbox override handled=%v requests=%d result=%+v err=%v", handled, requests, overridden, err)
	}
}

func TestResolverComponentRejectsUnsafeOrIncompatibleProfiles(t *testing.T) {
	root := t.TempDir()
	manager, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Stop()

	for _, raw := range []json.RawMessage{
		googleDriveUpdatePackage("1.0.0", "/uc-v2"),
		googleDriveUpdatePackage("1.1.0", "//example.test/steal"),
		googleDriveUpdatePackage("1.1.0", "/../uc"),
		json.RawMessage(strings.Replace(
			string(googleDriveUpdatePackage("1.1.0", "/uc-v2")),
			"TrueDown component test", "unsafe\\u0009agent", 1,
		)),
		json.RawMessage(`{"schemaVersion":1,"id":"google-drive","engine":"dropbox-v1","version":"1.1.0","releasedAt":"2026-08-20","config":{}}`),
		json.RawMessage(`{"schemaVersion":1,"id":"google-drive","engine":"google-drive-v1","version":"1.1.0","releasedAt":"2026-08-20","config":{"stableDownloadPath":"/uc","openPath":"/open","folderViewPath":"/folder","nativeExportPath":"/{type}/{id}","userAgent":"ok","unknown":true}}`),
	} {
		if _, err := manager.InstallModulePackage(raw); !IsValidationError(err) {
			t.Fatalf("unsafe component package error=%v package=%s", err, raw)
		}
	}
	if active := manager.modules.module(GoogleDriveModuleID).(*googleDriveResolverModule); active.profile.StableDownloadPath != "/uc" {
		t.Fatalf("invalid update changed the active component: %+v", active.profile)
	}
}
