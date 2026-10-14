package systemupdate

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCleanupLogsOnlyChangedFailuresAndRetainsRetries(t *testing.T) {
	var output bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&output)
	defer log.SetOutput(previous)
	reason := "checksum changed; preserving it"
	calls := 0
	m := newTestManager(t, t.TempDir(), "aria2.exe", Options{
		DownloadAsset: func(context.Context, string, string, string, int64, func(DownloadProgress)) (string, error) {
			return "", nil
		},
		CleanupAsset: func(string, string, string, int64) error {
			calls++
			if reason != "" {
				return fmt.Errorf("%s", reason)
			}
			return nil
		},
	})
	m.currentBuild, m.nativeExecutable, m.programUpdatesDisabled = 42, "TrueDown.exe", false
	receipt := updateDownload{Build: 42, Name: "TrueDown-build-42.zip", SHA256: sha256Hex([]byte("archive")), Size: 7}
	if err := m.recordUpdateDownload(receipt); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		m.cleanupUpdateDownloads()
	}
	if calls != 3 || strings.Count(output.String(), "clean installed update download") != 1 {
		t.Fatal("unchanged error repeated or retry was skipped", calls, output.String())
	}
	entries, err := m.readUpdateDownloads()
	if err != nil || len(entries) != 1 {
		t.Fatal("failed receipt lost", err)
	}
	reason = "file locked"
	m.cleanupUpdateDownloads()
	if strings.Count(output.String(), "clean installed update download") != 2 {
		t.Fatal("new reason was not logged")
	}
	reason = ""
	m.cleanupUpdateDownloads()
	entries, err = m.readUpdateDownloads()
	if err != nil || len(entries) != 0 || len(m.cleanupFailures) != 0 {
		t.Fatal("successful cleanup not reset", err)
	}
	if err := m.recordUpdateDownload(receipt); err != nil {
		t.Fatal(err)
	}
	reason = "file locked"
	m.cleanupUpdateDownloads()
	if strings.Count(output.String(), "clean installed update download") != 3 {
		t.Fatal("a new failed cleanup was suppressed")
	}
}

func TestUpdateCleanupSurvivesRestartAndWaitsForHealthyInstallation(t *testing.T) {
	root := t.TempDir()
	var calls int
	locked := false
	options := Options{
		DownloadAsset: func(context.Context, string, string, string, int64, func(DownloadProgress)) (string, error) {
			return "", nil
		},
		CleanupAsset: func(directory, name, digest string, size int64) error {
			calls++
			if directory != filepath.Join(root, "updates") || name != "TrueDown-build-42.zip" {
				t.Fatal("wrong cleanup target", directory, name)
			}
			if locked {
				return fmt.Errorf("file is locked")
			}
			return nil
		},
	}
	m := newTestManager(t, root, filepath.Join(root, "aria2.exe"), options)
	m.currentBuild, m.nativeExecutable, m.programUpdatesDisabled = 41, filepath.Join(root, "TrueDown.exe"), false
	receipt := updateDownload{Build: 42, Name: "TrueDown-build-42.zip", SHA256: sha256Hex([]byte("archive")), Size: 7}
	if err := m.recordUpdateDownload(receipt); err != nil {
		t.Fatal(err)
	}
	m.cleanupUpdateDownloads()
	if calls != 0 {
		t.Fatal("staged update was cleaned before installation")
	}
	// A replacement process must read the durable journal, not an in-memory map.
	m = newTestManager(t, root, filepath.Join(root, "aria2.exe"), options)
	m.currentBuild, m.nativeExecutable, m.programUpdatesDisabled = 42, filepath.Join(root, "TrueDown.exe"), false
	marker := filepath.Join(root, nativeMarkerName)
	if err := os.WriteFile(marker, []byte("pending health"), 0600); err != nil {
		t.Fatal(err)
	}
	m.cleanupUpdateDownloads()
	if calls != 0 {
		t.Fatal("update cleaned before health confirmation")
	}
	if err := os.Remove(marker); err != nil {
		t.Fatal(err)
	}
	locked = true
	m.cleanupUpdateDownloads()
	entries, err := m.readUpdateDownloads()
	if err != nil || len(entries) != 1 || calls != 1 {
		t.Fatal("failed cleanup was not retained", entries, err, calls)
	}
	locked = false
	m.cleanupUpdateDownloads()
	m.cleanupUpdateDownloads()
	entries, err = m.readUpdateDownloads()
	if err != nil || len(entries) != 0 || calls != 2 {
		t.Fatal("successful cleanup was not committed", entries, err, calls)
	}
}

func TestNextCleanupRequiresPersistedVerifiedEngine(t *testing.T) {
	root := t.TempDir()
	var calls int
	m := newTestManager(t, root, filepath.Join(root, "aria2.exe"), Options{
		DownloadAsset: func(context.Context, string, string, string, int64, func(DownloadProgress)) (string, error) {
			return "", nil
		},
		CleanupAsset: func(string, string, string, int64) error { calls++; return nil },
	})
	data := []byte("verified NEXT")
	receipt := updateDownload{Name: "aria2-next-2.7.2-windows-x86_64.exe", SHA256: sha256Hex(data), Size: int64(len(data))}
	if err := m.recordUpdateDownload(receipt); err != nil {
		t.Fatal(err)
	}
	m.cleanupUpdateDownloads()
	if calls != 0 {
		t.Fatal("uninstalled engine cleaned")
	}
	m.state.NextEngine = &installedEngine{Version: "2.7.2", File: receipt.Name, SHA256: receipt.SHA256}
	m.cleanupUpdateDownloads()
	if calls != 0 {
		t.Fatal("missing installed engine cleaned")
	}
	if err := os.MkdirAll(m.enginesDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(m.enginesDir, receipt.Name), data, 0700); err != nil {
		t.Fatal(err)
	}
	m.cleanupUpdateDownloads()
	if calls != 1 {
		t.Fatal("installed engine download was not cleaned")
	}
	m.state.PreviousNextEngine, m.state.NextEngine = m.state.NextEngine, nil
	if err := m.recordUpdateDownload(receipt); err != nil {
		t.Fatal(err)
	}
	m.state.PreviousNextEngine.SHA256 = strings.Repeat("f", 64)
	m.cleanupUpdateDownloads()
	if calls != 1 {
		t.Fatal("unverified retained engine authorized cleanup")
	}
	m.state.PreviousNextEngine.SHA256 = receipt.SHA256
	m.cleanupUpdateDownloads()
	if calls != 2 {
		t.Fatal("retained engine download was not cleaned after rollback")
	}
	if _, err := os.Stat(filepath.Join(m.enginesDir, receipt.Name)); err != nil {
		t.Fatal("installed engine removed", err)
	}
}
