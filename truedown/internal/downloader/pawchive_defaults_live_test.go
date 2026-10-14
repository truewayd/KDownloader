package downloader

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

type pawchiveLiveSample struct {
	Post   string `json:"post"`
	URL    string `json:"url"`
	Name   string `json:"name"`
	Role   string `json:"role"`
	SHA256 string `json:"sha256"`
}

type pawchiveLiveResult struct {
	pawchiveLiveSample
	Status string `json:"status"`
	Bytes  int    `json:"bytes,omitempty"`
	Error  string `json:"error,omitempty"`
}

// Supply a fresh, disjoint URL manifest from creator metadata. Do not open or
// probe the media before this run: cached/browser-warmed URLs weaken acceptance.
func TestPawchiveDefaultsLive(t *testing.T) {
	if os.Getenv("TRUEDOWN_PAWCHIVE_LIVE") != "1" {
		t.Skip("requires explicit Pawchive live-download opt-in")
	}
	data, err := os.ReadFile(os.Getenv("TRUEDOWN_PAWCHIVE_SAMPLES"))
	if err != nil {
		t.Fatal("provide a fresh sample manifest", err)
	}
	var samples []pawchiveLiveSample
	if err := json.Unmarshal(data, &samples); err != nil || len(samples) < 8 || len(samples) > 64 {
		t.Fatal("sample manifest must contain 8 to 64 unique media URLs", err)
	}
	seen := make(map[string]bool)
	validHash := regexp.MustCompile(`^[0-9a-f]{64}$`)
	for _, sample := range samples {
		u, err := url.Parse(sample.URL)
		if err != nil || u.Scheme != "https" || u.Host != "file.pawchive.pw" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || !strings.HasPrefix(u.Path, "/data/") ||
			seen[sample.URL] || sample.Post == "" || !validHash.MatchString(sample.SHA256) ||
			strings.TrimSuffix(filepath.Base(u.Path), filepath.Ext(u.Path)) != sample.SHA256 {
			t.Fatal("invalid or repeated sample identity")
		}
		seen[sample.URL] = true
	}
	engine, err := integrationAria2Path()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	m, err := NewManagerWithConfig(engine, filepath.Join(root, "downloads"), filepath.Join(root, "records.db"), integrationManagerConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer m.Stop()
	if m.RuntimeSettings().ConcurrentDownloads != 3 {
		t.Fatal("fresh queue default is not three")
	}
	// Match KDownloader's ordinary ABDM request: UA/referrer headers, no custom
	// task options, no site module, no connection/retry overrides or extra delay.
	opts := Aria2Opts{}
	ua := "KDownloader/3.3.0 (+https://github.com/truewayd/KDownloader)"
	check := m.engineTaskOptions(&Task{Link: samples[0].URL, Headers: map[string]string{"User-Agent": ua}, Opts: opts}, false, false, false)
	if check["split"] != "16" || check["max-connection-per-server"] != "16" || check["max-tries"] != "5" {
		t.Fatal("test still contains a site-specific connection/retry policy", check["split"], check["max-tries"])
	}
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	client := m.rpc.(*ariaClient)
	var global map[string]string
	if err := client.call("aria2.getGlobalOption", nil, &global); err != nil || global["max-concurrent-downloads"] != "3" {
		t.Fatal("native queue does not use the default concurrency", err)
	}
	wirePath := filepath.Join(root, "wire.log")
	if !m.aria2Next {
		if err := m.rpc.changeGlobalOptions(map[string]string{"log": filepath.ToSlash(wirePath), "log-level": "debug"}); err != nil {
			t.Fatal(err)
		}
	}
	ids := make([]int64, 0, len(samples))
	for i, sample := range samples {
		headers := map[string]string{"User-Agent": ua, "Accept": "*/*", "Referer": "https://pawchive.pw/fanbox/user/2131660/post/" + sample.Post}
		task, _, err := m.AddTask(sample.URL, fmt.Sprintf("sample-%02d%s", i, filepath.Ext(sample.URL)), "", headers, "", 0, opts)
		if err != nil {
			t.Fatal(err)
		}
		if task.ModuleID != "" {
			t.Fatal("ordinary Pawchive media unexpectedly matched a backend module")
		}
		ids = append(ids, task.ID)
	}
	deadline := time.Now().Add(120 * time.Second)
	results := make([]pawchiveLiveResult, len(samples))
	settled := make(map[int64]bool)
	failed, totalBytes, peakActive := 0, 0, 0
	for len(settled) < len(ids) {
		if statuses, err := m.rpc.statuses(); err == nil {
			active := 0
			for _, state := range statuses {
				if state.Status == "active" {
					active++
				}
			}
			if active > peakActive {
				peakActive = active
			}
		}
		for i, id := range ids {
			if settled[id] {
				continue
			}
			task, _ := m.GetTask(id)
			if task.Status != StatusDone && task.Status != StatusError && time.Now().Before(deadline) {
				continue
			}
			result := pawchiveLiveResult{pawchiveLiveSample: samples[i], Status: string(task.Status), Error: task.Error}
			if task.Status == StatusDone {
				content, err := os.ReadFile(filepath.Join(task.Folder, task.OutputName))
				if err != nil || fmt.Sprintf("%x", sha256.Sum256(content)) != samples[i].SHA256 {
					result.Status, result.Error = "hash-failed", "output does not match source SHA-256"
				} else {
					result.Bytes = len(content)
					totalBytes += len(content)
				}
			}
			if result.Status != string(StatusDone) {
				failed++
			}
			results[i], settled[id] = result, true
			t.Logf("post=%s role=%s status=%s bytes=%d sha256=%s", result.Post, result.Role, result.Status, result.Bytes, result.SHA256)
		}
		if len(settled) < len(ids) {
			time.Sleep(50 * time.Millisecond)
		}
	}
	requests, minGap, forbidden := -1, int64(-1), -1
	if !m.aria2Next {
		wire, err := os.ReadFile(wirePath)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(wire), "User-Agent: "+ua) {
			t.Fatal("native requests ignored KDownloader's UA header")
		}
		starts := regexp.MustCompile(`(?m)(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+) .*Requesting:\r?\nGET /data/`).FindAllStringSubmatch(string(wire), -1)
		requests = len(starts)
		for i := 1; i < len(starts); i++ {
			previous, _ := time.Parse("2006-01-02 15:04:05.000000", starts[i-1][1])
			current, _ := time.Parse("2006-01-02 15:04:05.000000", starts[i][1])
			gap := current.Sub(previous).Microseconds()
			if minGap < 0 || gap < minGap {
				minGap = gap
			}
		}
		forbidden = strings.Count(string(wire), "HTTP/1.1 403")
	}
	if reportPath := os.Getenv("TRUEDOWN_PAWCHIVE_REPORT"); reportPath != "" {
		var wireRequests, wireGap, wireForbidden any
		if !m.aria2Next {
			wireRequests, wireGap, wireForbidden = requests, minGap, forbidden
		}
		report := map[string]any{"engine": filepath.Base(engine), "nextVersion": m.aria2NextVersion,
			"testedAt":         time.Now().UTC().Format(time.RFC3339),
			"queueConcurrency": 3, "connections": 16, "maxTries": 5, "sitePolicy": false,
			"done": len(samples) - failed, "failed": failed, "totalBytes": totalBytes, "peakActive": peakActive,
			"nativeRequests": wireRequests, "minimumRequestGapMicroseconds": wireGap, "http403Responses": wireForbidden, "files": results}
		encoded, _ := json.MarshalIndent(report, "", "  ")
		if err := os.WriteFile(reportPath, append(encoded, '\n'), 0600); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("done=%d/%d bytes=%d peakActive=%d nativeRequests=%d minGapUs=%d http403=%d", len(samples)-failed, len(samples), totalBytes, peakActive, requests, minGap, forbidden)
	if failed != 0 || peakActive > 3 {
		t.Fatalf("default queue acceptance failed: failures=%d peakActive=%d", failed, peakActive)
	}
}
