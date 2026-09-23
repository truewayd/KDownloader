package systemupdate

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestDiscoverTrueDownReleaseAssetFallback(t *testing.T) {
	for _, scenario := range []struct {
		name      string
		inline    bool
		missing   bool
		status    int
		id        int64
		wantError string
	}{
		{name: "complete inline", inline: true, id: 47},
		{name: "empty projection", id: 47},
		{name: "partial projection", id: 47},
		{name: "still uploading", id: 47, missing: true, wantError: "not ready"},
		{name: "rate limited", id: 47, status: 403, wantError: "HTTP 403"},
		{name: "invalid release identity", id: -1, wantError: "incomplete asset metadata"},
		{name: "asset page limit", id: 47, wantError: "supported limit"},
		{name: "duplicate assets", id: 47, wantError: "not ready"},
		{name: "oversized response", id: 47, wantError: "allowed size"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			var calls atomic.Int32
			assets := []githubAsset{
				{Name: "TrueDown-build-47.zip", Size: 1024, BrowserDownloadURL: "https://github.com/truewayd/KDownloader/releases/download/truedown-build-47/TrueDown-build-47.zip"},
				{Name: "truedown-update-47.json", Size: 512, BrowserDownloadURL: "https://github.com/truewayd/KDownloader/releases/download/truedown-build-47/truedown-update-47.json"},
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/releases":
					inline := []githubAsset(nil)
					if scenario.inline {
						inline = assets
					}
					if scenario.name == "partial projection" {
						inline = assets[:1]
					}
					_ = json.NewEncoder(w).Encode([]any{
						map[string]any{"id": scenario.id, "tag_name": "truedown-build-47", "assets": inline, "assets_url": "https://untrusted.example/assets"},
						githubRelease{ID: 48, TagName: "truedown-build-48", Draft: true},
						githubRelease{ID: 49, TagName: "truedown-build-49", Prerelease: true},
						githubRelease{ID: 50, TagName: "kdownloader-v2.0.2-build-50"},
					})
				case "/releases/47/assets":
					calls.Add(1)
					if r.URL.RawQuery != "per_page=100" {
						t.Errorf("unexpected query: %s", r.URL.RawQuery)
					}
					if scenario.status != 0 {
						w.WriteHeader(scenario.status)
						return
					}
					if scenario.missing {
						_ = json.NewEncoder(w).Encode(assets[:1])
						return
					}
					if scenario.name == "asset page limit" {
						_ = json.NewEncoder(w).Encode(make([]githubAsset, 100))
						return
					}
					if scenario.name == "duplicate assets" {
						_ = json.NewEncoder(w).Encode(append(assets, assets[0]))
						return
					}
					if scenario.name == "oversized response" {
						_, _ = w.Write([]byte(strings.Repeat(" ", maxGitHubResponseBytes+1)))
						return
					}
					_ = json.NewEncoder(w).Encode(assets)
				default:
					t.Errorf("unexpected request: %s", r.URL)
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			manager := &Manager{client: server.Client(), currentBuild: 46, trueDownReleasesURL: server.URL + "/releases?per_page=50", allowInsecureLoopback: true}
			available, err := manager.discoverTrueDownRelease(context.Background())
			if scenario.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), scenario.wantError) || available != nil {
					t.Fatalf("result=%+v err=%v", available, err)
				}
			} else if err != nil || available == nil || available.Build != 47 || available.ArchiveSize != 1024 || available.ManifestSize != 512 {
				t.Fatalf("result=%+v err=%v", available, err)
			}
			expected := 1
			if scenario.inline || scenario.id <= 0 {
				expected = 0
			}
			if calls.Load() != int32(expected) {
				t.Fatalf("asset requests=%d, want %d", calls.Load(), expected)
			}
		})
	}
}

func TestDiscoveryDoesNotSkipIncompleteNewestRelease(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.URL.Path == "/releases" {
			_ = json.NewEncoder(w).Encode([]githubRelease{
				{ID: 47, TagName: "truedown-build-47", Assets: []githubAsset{{Name: "TrueDown-build-47.zip", Size: 10}, {Name: "truedown-update-47.json", Size: 10}}},
				{ID: 48, TagName: "truedown-build-48"},
			})
		} else {
			if r.URL.Path != "/releases/48/assets" {
				t.Errorf("unexpected endpoint %s", r.URL.Path)
			}
			_, _ = w.Write([]byte("[]"))
		}
	}))
	defer server.Close()
	manager := &Manager{client: server.Client(), currentBuild: 46, trueDownReleasesURL: server.URL + "/releases", allowInsecureLoopback: true}
	if update, err := manager.discoverTrueDownRelease(context.Background()); update != nil || err == nil {
		t.Fatalf("result=%+v err=%v", update, err)
	}
	if requests.Load() != 2 {
		t.Fatalf("unbounded fallback requests: %d", requests.Load())
	}
	manager.currentBuild = 48
	requests.Store(0)
	if update, err := manager.discoverTrueDownRelease(context.Background()); update != nil || err != nil {
		t.Fatalf("result=%+v err=%v", update, err)
	}
	if requests.Load() != 1 {
		t.Fatalf("current build fetched assets: %d", requests.Load())
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := manager.discoverTrueDownRelease(ctx); err == nil {
		t.Fatal("cancelled check succeeded")
	}
}
