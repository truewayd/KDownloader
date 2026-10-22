package downloader

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPublishedResolverProfiles(t *testing.T) {
	for _, factory := range resolverComponentFactories() {
		if executableModule(factory.id) {
			continue
		}
		raw, err := os.ReadFile(filepath.Join("..", "..", "modules", "profiles", factory.id+".json"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := decodeComponent(factory, raw, "updated"); err != nil {
			t.Fatalf("published %s profile is incompatible: %v", factory.id, err)
		}
	}
}

func profileReleaseClient(t *testing.T, raw []byte, checksum string, beforePackage func()) *http.Client {
	t.Helper()
	return &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.Header.Get("Cookie") != "" || request.Header.Get("Authorization") != "" {
			t.Error("profile checks forwarded private credentials")
		}
		body := ""
		switch {
		case request.URL.Hostname() == "api.github.com":
			body = `[{"tag_name":"truedown-module-google-drive-v1.1.0"},{"tag_name":"truedown-module-google-drive-v9.0.0","draft":true},{"tag_name":"truedown-module-mega-v99.0.0"}]`
		case request.URL.String() == moduleReleaseBase(GoogleDriveModuleID, "1.1.0")+"google-drive.json":
			if beforePackage != nil {
				beforePackage()
			}
			body = string(raw)
		case request.URL.String() == moduleReleaseBase(GoogleDriveModuleID, "1.1.0")+"google-drive.sha256":
			body = checksum
		default:
			return nil, fmt.Errorf("unexpected profile request")
		}
		return googleDriveTestResponse(request, http.StatusOK, body, http.Header{}), nil
	})}
}

func TestResolverProfileReleaseHotUpdatesPersistsAndResets(t *testing.T) {
	root := t.TempDir()
	database := filepath.Join(root, "records.db")
	m, err := NewManager("unused", filepath.Join(root, "downloads"), database)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	old := m.modules.module(GoogleDriveModuleID).(*googleDriveResolverModule)
	if _, err := m.SetModuleInstalled(GoogleDriveModuleID, false); err != nil {
		t.Fatal(err)
	}
	raw := googleDriveUpdatePackage("1.1.0", "/uc-v2")
	hash := sha256.Sum256(raw)
	client := profileReleaseClient(t, raw, hex.EncodeToString(hash[:])+"\n", nil)
	version, err := m.updateResolverProfileWithClient(context.Background(), client, GoogleDriveModuleID)
	if err != nil || version != "1.1.0" {
		t.Fatalf("profile release did not activate: %s, %v", version, err)
	}
	if old.profile.StableDownloadPath != "/uc" || m.modules.module(GoogleDriveModuleID).(*googleDriveResolverModule).profile.StableDownloadPath != "/uc-v2" {
		t.Fatal("profile activation modified an in-flight snapshot or kept the old component")
	}
	m.Stop()
	m, err = NewManager("unused", filepath.Join(root, "downloads"), database)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	for _, info := range m.Modules() {
		if info.ID == GoogleDriveModuleID && (info.Version != version || info.Installed || info.Source != "updated") {
			t.Fatalf("update changed enablement or did not persist: %+v", info)
		}
	}
	if _, err := m.ResetModulePackage(GoogleDriveModuleID); err != nil {
		t.Fatal(err)
	}
	if m.modules.module(GoogleDriveModuleID).(*googleDriveResolverModule).profile.StableDownloadPath != "/uc" {
		t.Fatal("restore baseline did not restore the embedded component")
	}
}

func TestResolverProfileReleaseFailuresKeepActiveProfile(t *testing.T) {
	for _, failure := range []string{"checksum", "identity", "version", "unknown-field", "oversize", "concurrent-update", "cancelled"} {
		t.Run(failure, func(t *testing.T) {
			m, _ := transferTestManager(t)
			raw := googleDriveUpdatePackage("1.1.0", "/uc-v2")
			switch failure {
			case "identity":
				raw = json.RawMessage(strings.Replace(string(raw), `"id":"google-drive"`, `"id":"dropbox"`, 1))
			case "version":
				raw = googleDriveUpdatePackage("1.2.0", "/uc-v2")
			case "unknown-field":
				raw = json.RawMessage(strings.Replace(string(raw), `"config":{`, `"config":{"executable":"evil",`, 1))
			case "oversize":
				raw = append(raw, []byte(strings.Repeat(" ", maxModulePackageBytes))...)
			}
			hash := sha256.Sum256(raw)
			checksum := hex.EncodeToString(hash[:])
			if failure == "checksum" {
				checksum = strings.Repeat("0", 64)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			client := profileReleaseClient(t, raw, checksum, func() {
				if failure == "cancelled" {
					cancel()
				}
				if failure == "concurrent-update" {
					if _, err := m.InstallModulePackage(googleDriveUpdatePackage("1.2.0", "/newer")); err != nil {
						t.Fatal(err)
					}
				}
			})
			if _, err := m.updateResolverProfileWithClient(ctx, client, GoogleDriveModuleID); err == nil {
				t.Fatal("invalid or obsolete update was accepted")
			}
			want := "/uc"
			if failure == "concurrent-update" {
				want = "/newer"
			}
			if m.modules.module(GoogleDriveModuleID).(*googleDriveResolverModule).profile.StableDownloadPath != want {
				t.Fatal("failed update replaced the active profile")
			}
		})
	}
}

func TestResolverProfileCanChangeNamePolicyWithoutManagerChanges(t *testing.T) {
	m, _ := transferTestManager(t)
	legacy := strings.Replace(string(googleDriveUpdatePackage("1.1.0", "/uc")), `"config":{`, `"config":{"nameSource":"legacy-output",`, 1)
	if _, err := m.InstallModulePackage(json.RawMessage(legacy)); err != nil {
		t.Fatal(err)
	}
	task := &Task{Name: "Process B", ModuleID: GoogleDriveModuleID}
	metadata := remoteMetadata{Name: "Process B.png"}
	metadata.NameSource = m.modules.module(GoogleDriveModuleID).(*googleDriveResolverModule).profile.NameSource
	if validateRemoteMetadata(task, metadata, "Google Drive") == nil {
		t.Fatal("legacy module policy did not reproduce the original failure")
	}
	updated := strings.Replace(legacy, `"1.1.0"`, `"1.1.1"`, 1)
	updated = strings.Replace(updated, `"legacy-output"`, `"response"`, 1)
	if _, err := m.InstallModulePackage(json.RawMessage(updated)); err != nil {
		t.Fatal(err)
	}
	metadata.NameSource = m.modules.module(GoogleDriveModuleID).(*googleDriveResolverModule).profile.NameSource
	if err := validateRemoteMetadata(task, metadata, "Google Drive"); err != nil {
		t.Fatalf("module update did not fix the retry: %v", err)
	}
	task.RemoteName = "original.png"
	if validateRemoteMetadata(task, metadata, "Google Drive") == nil {
		t.Fatal("module policy bypassed an established remote identity")
	}
	m.moduleUpdateState = ModuleUpdateState{ID: GoogleDriveModuleID, Running: true}
	if _, err := m.ResetModulePackage(GoogleDriveModuleID); err == nil {
		t.Fatal("baseline reset raced an active profile update")
	}
	if err := m.StartModuleUpdate(DropboxModuleID); err == nil {
		t.Fatal("a different module's check was incorrectly coalesced")
	}
}
