package downloader

import (
	"bytes"
	"context"
	"crypto/sha256"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLiveDropboxFolderFilterAndFile(t *testing.T) {
	source := os.Getenv("TRUEDOWN_DROPBOX_TEST_URL")
	if source == "" {
		t.Skip("explicit public Dropbox folder fixture required")
	}
	root := artifactTempDir(t)
	engine, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	m, err := NewManagerWithConfig(engine, filepath.Join(root, "downloads"), filepath.Join(root, "records.db"), integrationManagerConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	opts := Aria2Opts{Connections: 1, MaxTries: 1}.WithStartPaused(true)
	if _, err := m.SetDownloadRules(DownloadRules{DropboxMode: DropboxModeExpand, FilterMode: DropboxFilterOff}); err != nil {
		t.Fatal(err)
	}
	result, _, err := m.AddWithModules(context.Background(), source, "", "", nil, "", 0, opts, nil)
	if err != nil || len(result.Tasks) == 0 {
		t.Fatal("Dropbox folder did not expand", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	var chosen *Task
	var length int64
	for _, task := range result.Tasks {
		metadata, err := resolveDropboxDirectURL(ctx, task, m.dropboxClient)
		if err == nil && metadata.LengthKnown && metadata.Length > 0 && metadata.Length <= 20*1024*1024 {
			chosen, length = task, metadata.Length
			break
		}
	}
	if chosen == nil {
		t.Fatal("public Dropbox fixture has no file within the 20 MiB test budget")
	}
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, chosen.Link, nil)
	response, err := m.dropboxClient.Do(request)
	if err != nil {
		t.Fatal("Dropbox reference download failed")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 20*1024*1024+1))
	response.Body.Close()
	if err != nil || response.StatusCode != http.StatusOK || int64(len(data)) != length {
		t.Fatal("Dropbox reference download differs from its metadata")
	}
	suffix := strings.ToUpper(filepath.Ext(chosen.Name))
	if suffix == "" {
		t.Fatal("public fixture needs a suffix for filter acceptance")
	}
	if _, err := m.SetDownloadRules(DownloadRules{DropboxMode: DropboxModeExpand, FilterMode: DropboxFilterCustom, ExcludedExtensions: []string{suffix}}); err != nil {
		t.Fatal(err)
	}
	filtered, _, err := m.AddWithModules(ctx, source, "", "", nil, "", 0, opts, nil)
	if err != nil || filtered.Filtered == 0 || len(filtered.Tasks)+filtered.Filtered != len(result.Tasks) {
		t.Fatal("shared Dropbox suffix filter did not exclude the public file", err)
	}
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	// A filter change does not revoke an already accepted file task.
	if err := m.ResumeTask(chosen.ID); err != nil {
		t.Fatal(err)
	}
	current := waitLiveMegaTask(t, m, chosen.ID)
	actual, err := os.ReadFile(filepath.Join(current.Folder, current.OutputName))
	if err != nil || !bytes.Equal(actual, data) {
		t.Fatal("aria2 Dropbox output differs from the public reference bytes", err)
	}
	t.Logf("public Dropbox folder: files=%d filtered=%d, downloaded=%s bytes=%d sha256=%x", len(result.Tasks), filtered.Filtered, current.OutputName, len(actual), sha256.Sum256(actual))
}

func TestLiveGoogleDriveFolderFilterAndExport(t *testing.T) {
	source := os.Getenv("TRUEDOWN_GOOGLE_DRIVE_FOLDER_TEST_URL")
	if source == "" {
		t.Skip("explicit small Slides folder fixture required")
	}
	root := artifactTempDir(t)
	engine, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	m, err := NewManagerWithConfig(engine, filepath.Join(root, "downloads"), filepath.Join(root, "records.db"), integrationManagerConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	opts := Aria2Opts{Connections: 1, MaxTries: 1, ProxyMode: "custom", ExtraArgs: []string{"--all-proxy=" + os.Getenv("TRUEDOWN_MEGA_TEST_HTTP_PROXY")}}.WithStartPaused(true)
	if _, err := m.SetDownloadRules(DownloadRules{FilterMode: DropboxFilterCustom, ExcludedExtensions: []string{".PPTX"}}); err != nil {
		t.Fatal(err)
	}
	filtered, handled, err := m.AddWithModules(context.Background(), source, "", "", nil, "", 0, opts, nil)
	if err != nil || !handled || filtered.Filtered != 1 || len(filtered.Tasks) != 0 {
		t.Fatalf("Drive export suffix filter: handled=%v tasks=%d filtered=%d err=%v", handled, len(filtered.Tasks), filtered.Filtered, err)
	}
	if _, err := m.SetDownloadRules(DownloadRules{FilterMode: DropboxFilterOff}); err != nil {
		t.Fatal(err)
	}
	result, handled, err := m.AddWithModules(context.Background(), source, "", "", nil, "", 0, opts, nil)
	if err != nil || !handled || len(result.Tasks) != 1 {
		t.Fatal("Drive public folder did not expand", err)
	}
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	if err := m.ResumeTask(result.Tasks[0].ID); err != nil {
		t.Fatal(err)
	}
	current := waitLiveMegaTask(t, m, result.Tasks[0].ID)
	data, err := os.ReadFile(filepath.Join(current.Folder, current.OutputName))
	if err != nil || len(data) > 20*1024*1024 || !bytes.HasPrefix(data, []byte("PK\x03\x04")) {
		t.Fatal("Drive export is not a valid small PPTX", err)
	}
	t.Logf("public Drive folder: filtered=%d, downloaded=%s bytes=%d sha256=%x", filtered.Filtered, current.OutputName, len(data), sha256.Sum256(data))
}
