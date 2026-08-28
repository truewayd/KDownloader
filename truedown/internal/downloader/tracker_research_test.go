package downloader

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestTrackerResearchDefaultsMatchMVPModel(t *testing.T) {
	settings := defaultTrackerResearchSettings()
	if settings.Enabled || settings.MinimumLeechers != 3 || settings.DownloadMultiplierMin != 0 ||
		settings.DownloadMultiplierMax != 0.001 || settings.UploadMultiplierMin != 2 ||
		settings.UploadMultiplierMax != 8 || settings.BonusKiBPerSecond != 15 ||
		settings.BonusChancePercent != 5 || settings.ReportDownloadAsZero || settings.PretendToSeed ||
		!settings.OnlyTrackerTraffic || !settings.OnlyLocalConnections {
		t.Fatalf("unexpected defaults: %+v", settings)
	}
}

func TestTrackerResearchSnapshotDescribesEngineRequirement(t *testing.T) {
	root := t.TempDir()
	manager, err := NewManagerWithConfig(
		"unused",
		filepath.Join(root, "downloads"),
		filepath.Join(root, "records.db"),
		ManagerConfig{Aria2Next: true, Aria2NextVersion: "2.5.6"},
	)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Stop()
	snapshot := manager.TrackerResearchSettings()
	if snapshot.Engine != "next" || snapshot.EngineVersion != "2.5.6" ||
		snapshot.RequiredRPC != "aria2.replaceBtTrackers" || snapshot.MinimumNextVersion != "2.5.7" {
		t.Fatalf("tracker research requirement snapshot=%+v", snapshot)
	}
}

func TestTrackerResearchRatioRewriteUsesPreviousLeecherCount(t *testing.T) {
	module := &trackerResearchModule{
		settings: TrackerResearchSettings{
			Enabled:               true,
			MinimumLeechers:       3,
			DownloadMultiplierMin: 0.001,
			DownloadMultiplierMax: 0.001,
			UploadMultiplierMin:   2,
			UploadMultiplierMax:   2,
			BonusKiBPerSecond:     15,
			BonusChancePercent:    5,
			ReportDownloadAsZero:  true,
			PretendToSeed:         true,
			OnlyTrackerTraffic:    true,
			OnlyLocalConnections:  true,
		},
		announces: make(map[string]*trackerAnnounceState),
		now:       func() time.Time { return time.Unix(100, 0) },
		random:    func() float64 { return 0 },
	}
	first := url.Values{
		"downloaded": {"100"},
		"uploaded":   {"10"},
		"left":       {"1000"},
		"event":      {"started"},
	}
	module.rewriteAnnounce(first, "hash")
	if first.Get("uploaded") != "10" || first.Get("downloaded") != "0" || first.Get("left") != "0" {
		t.Fatalf("first announce=%v", first)
	}
	module.mu.Lock()
	module.announces["hash"].lastIncomplete = 3
	module.now = func() time.Time { return time.Unix(110, 0) }
	randomValues := []float64{0, 0, 0, 0.5}
	module.random = func() float64 {
		value := randomValues[0]
		randomValues = randomValues[1:]
		return value
	}
	module.mu.Unlock()
	second := url.Values{
		"downloaded": {"1100"},
		"uploaded":   {"20"},
		"left":       {"900"},
		"event":      {"completed"},
	}
	module.rewriteAnnounce(second, "hash")
	// 10 previous + 10 actual + 0.001*1000 + 2*10 + 15*1024*10*0.5.
	if second.Get("uploaded") != "76841" || second.Get("downloaded") != "0" || second.Get("left") != "0" || second.Has("event") {
		t.Fatalf("second announce=%v", second)
	}
}

func TestTrackerResearchReplacementPreservesUDP(t *testing.T) {
	module, err := newTrackerResearchModule(filepath.Join(t.TempDir(), "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := module.startRelay(); err != nil {
		t.Fatal(err)
	}
	defer module.close()
	originals := []btTrackerConfig{
		{URL: "http://tracker.example/announce", Tier: 0},
		{URL: "udp://tracker.example:80/announce", Tier: 1},
		{URL: "https://tracker.example/announce", Tier: 2},
	}
	replacement, _, tokens := module.buildReplacement(originals)
	if len(tokens) != 2 || replacement[1] != originals[1] {
		t.Fatalf("replacement=%+v tokens=%d", replacement, len(tokens))
	}
	if !strings.HasPrefix(replacement[0].URL, "http://127.0.0.1:") ||
		!strings.HasPrefix(replacement[2].URL, "http://127.0.0.1:") ||
		replacement[0].Tier != 0 || replacement[2].Tier != 2 {
		t.Fatalf("unexpected relay replacement: %+v", replacement)
	}
}

func TestTrackerResearchRelayForwardsHTTPSWithoutMITM(t *testing.T) {
	var upstreamQuery url.Values
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		upstreamQuery = request.URL.Query()
		response.Header().Set("Content-Type", "text/plain")
		_, _ = io.WriteString(response, "d8:intervali1800e10:incompletei7ee")
	}))
	defer upstream.Close()
	module, err := newTrackerResearchModule(filepath.Join(t.TempDir(), "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	module.settings.Enabled = true
	module.client = upstream.Client()
	if err := module.startRelay(); err != nil {
		t.Fatal(err)
	}
	defer module.close()
	original, err := url.Parse(upstream.URL + "/announce?passkey=controlled-test")
	if err != nil {
		t.Fatal(err)
	}
	token, err := newTrackerRelayToken()
	if err != nil {
		t.Fatal(err)
	}
	module.mu.Lock()
	module.bindings[token] = trackerRelayBinding{original: original}
	module.mu.Unlock()
	relayURL := module.relayBaseURL() + token + "?info_hash=test-hash&downloaded=100&uploaded=10&left=1000&event=started"
	response, err := http.Get(relayURL)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || string(body) != "d8:intervali1800e10:incompletei7ee" {
		t.Fatalf("relay status=%d body=%q", response.StatusCode, body)
	}
	if upstreamQuery.Get("passkey") != "controlled-test" || upstreamQuery.Get("uploaded") != "10" || upstreamQuery.Get("info_hash") != "test-hash" {
		t.Fatalf("upstream query=%v", upstreamQuery)
	}
	module.mu.Lock()
	state := module.announces[token+"\x00test-hash"]
	forwarded := module.forwardedAnnounces
	module.mu.Unlock()
	if state == nil || state.lastIncomplete != 7 || forwarded != 1 {
		t.Fatalf("state=%+v forwarded=%d", state, forwarded)
	}
}

func TestTrackerResearchDisabledRelayDoesNotRewriteAnnouncements(t *testing.T) {
	module := &trackerResearchModule{
		settings:  defaultTrackerResearchSettings(),
		announces: make(map[string]*trackerAnnounceState),
		now:       time.Now,
		random:    func() float64 { return 0 },
	}
	query := url.Values{"downloaded": {"12"}, "uploaded": {"34"}, "left": {"56"}}
	module.rewriteAnnounce(query, "token\x00hash")
	if query.Get("downloaded") != "12" || query.Get("uploaded") != "34" || query.Get("left") != "56" || len(module.announces) != 0 {
		t.Fatalf("disabled relay changed announce: %v state=%v", query, module.announces)
	}
}

func TestTrackerResearchSettingsPersistAndRequireConsent(t *testing.T) {
	root := t.TempDir()
	databasePath := filepath.Join(root, "records.db")
	manager, err := NewManager("unused", filepath.Join(root, "downloads"), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	update := TrackerResearchSettingsUpdate{
		Enabled:               true,
		MinimumLeechers:       4,
		DownloadMultiplierMin: 0.01,
		DownloadMultiplierMax: 0.02,
		UploadMultiplierMin:   3,
		UploadMultiplierMax:   7,
		BonusKiBPerSecond:     12,
		BonusChancePercent:    6,
		OnlyTrackerTraffic:    true,
		OnlyLocalConnections:  true,
	}
	if _, err := manager.UpdateTrackerResearchSettings(update); !IsValidationError(err) || !strings.Contains(err.Error(), "acknowledgedRisk") {
		t.Fatalf("enable without consent error=%v", err)
	}
	update.Enabled = false
	saved, err := manager.UpdateTrackerResearchSettings(update)
	if err != nil {
		t.Fatal(err)
	}
	if saved.MinimumLeechers != 4 || saved.DownloadMultiplierMax != 0.02 || saved.Enabled {
		t.Fatalf("saved settings=%+v", saved)
	}
	manager.Stop()
	reloaded, err := NewManager("unused", filepath.Join(root, "downloads"), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer reloaded.Stop()
	got := reloaded.TrackerResearchSettings()
	if got.MinimumLeechers != 4 || got.UploadMultiplierMax != 7 || got.Enabled {
		t.Fatalf("reloaded settings=%+v", got)
	}
}

type trackerResearchRPCStub struct {
	*fakeAriaRPC
	statusesValue []ariaStatus
	replacements  [][]btTrackerConfig
}

func (stub *trackerResearchRPCStub) supportsTrackerResearch() (bool, error) { return true, nil }

func (stub *trackerResearchRPCStub) replaceBtTrackers(_ string, trackers []btTrackerConfig) error {
	stub.replacements = append(stub.replacements, cloneTrackerConfigs(trackers))
	return nil
}

func (stub *trackerResearchRPCStub) statuses() ([]ariaStatus, error) {
	return stub.statusesValue, nil
}

func TestTrackerResearchManagerRewritesAndRestoresTieredTrackers(t *testing.T) {
	root := t.TempDir()
	manager, err := NewManager("unused", filepath.Join(root, "downloads"), filepath.Join(root, "records.db"))
	if err != nil {
		t.Fatal(err)
	}
	status := ariaStatus{GID: "0123456789abcdef", Status: "active"}
	status.Bittorrent = &ariaBitTorrentStatus{AnnounceList: [][]string{
		{"https://tracker.example/announce?passkey=private", "udp://tracker.example:80/announce"},
		{"http://backup.example/announce"},
	}}
	stub := &trackerResearchRPCStub{fakeAriaRPC: &fakeAriaRPC{}, statusesValue: []ariaStatus{status}}
	manager.rpc = stub
	settings := defaultTrackerResearchSettings()
	settings.Enabled = true
	enabled, err := manager.UpdateTrackerResearchSettings(TrackerResearchSettingsUpdate{
		Enabled:               settings.Enabled,
		MinimumLeechers:       settings.MinimumLeechers,
		DownloadMultiplierMin: settings.DownloadMultiplierMin,
		DownloadMultiplierMax: settings.DownloadMultiplierMax,
		UploadMultiplierMin:   settings.UploadMultiplierMin,
		UploadMultiplierMax:   settings.UploadMultiplierMax,
		BonusKiBPerSecond:     settings.BonusKiBPerSecond,
		BonusChancePercent:    settings.BonusChancePercent,
		ReportDownloadAsZero:  settings.ReportDownloadAsZero,
		PretendToSeed:         settings.PretendToSeed,
		OnlyTrackerTraffic:    settings.OnlyTrackerTraffic,
		OnlyLocalConnections:  settings.OnlyLocalConnections,
		AcknowledgedRisk:      true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !enabled.Active || enabled.ConfiguredTorrents != 1 || enabled.RewrittenTrackers != 2 || len(stub.replacements) != 1 {
		t.Fatalf("enabled=%+v replacements=%v", enabled, stub.replacements)
	}
	replaced := stub.replacements[0]
	if !strings.HasPrefix(replaced[0].URL, "http://127.0.0.1:") || replaced[1].URL != "udp://tracker.example:80/announce" ||
		!strings.HasPrefix(replaced[2].URL, "http://127.0.0.1:") || replaced[0].Tier != 0 || replaced[2].Tier != 1 {
		t.Fatalf("replaced trackers=%+v", replaced)
	}
	settings.Enabled = false
	disabled, err := manager.UpdateTrackerResearchSettings(TrackerResearchSettingsUpdate{
		Enabled:               settings.Enabled,
		MinimumLeechers:       settings.MinimumLeechers,
		DownloadMultiplierMin: settings.DownloadMultiplierMin,
		DownloadMultiplierMax: settings.DownloadMultiplierMax,
		UploadMultiplierMin:   settings.UploadMultiplierMin,
		UploadMultiplierMax:   settings.UploadMultiplierMax,
		BonusKiBPerSecond:     settings.BonusKiBPerSecond,
		BonusChancePercent:    settings.BonusChancePercent,
		ReportDownloadAsZero:  settings.ReportDownloadAsZero,
		PretendToSeed:         settings.PretendToSeed,
		OnlyTrackerTraffic:    settings.OnlyTrackerTraffic,
		OnlyLocalConnections:  settings.OnlyLocalConnections,
	})
	if err != nil {
		t.Fatal(err)
	}
	if disabled.Active || disabled.ConfiguredTorrents != 0 || len(stub.replacements) != 2 {
		t.Fatalf("disabled=%+v replacements=%v", disabled, stub.replacements)
	}
	restored := stub.replacements[1]
	if restored[0].URL != "https://tracker.example/announce?passkey=private" || restored[1].URL != "udp://tracker.example:80/announce" ||
		restored[2].URL != "http://backup.example/announce" {
		t.Fatalf("restored trackers=%+v", restored)
	}
	manager.Stop()
}

func TestBencodeDictionaryInt(t *testing.T) {
	value, ok := bencodeDictionaryInt([]byte("d8:completei2e5:peers6:binary10:incompletei19ee"), "incomplete")
	if !ok || value != 19 {
		t.Fatalf("value=%d ok=%v", value, ok)
	}
	for index, malformed := range []string{"", "li1ee", "d10:incomplete3:19e", "d10:incompletei19"} {
		if _, ok := bencodeDictionaryInt([]byte(malformed), "incomplete"); ok {
			t.Fatalf("malformed %s at %s was accepted", strconv.Itoa(index), fmt.Sprintf("%q", malformed))
		}
	}
}
