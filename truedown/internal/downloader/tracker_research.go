package downloader

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	trackerResearchWarning = "仅限在你控制的 tracker 或测试环境中研究流量；不得用于欺骗、滥用或违反服务条款。启用即表示你理解并自行承担全部后果。"
	trackerRelayBodyLimit  = 4 * 1024 * 1024
)

// TrackerResearchSettings controls the opt-in RatioGhost-compatible announce model.
type TrackerResearchSettings struct {
	Enabled               bool    `json:"enabled"`
	MinimumLeechers       int     `json:"minimumLeechers"`
	DownloadMultiplierMin float64 `json:"downloadMultiplierMin"`
	DownloadMultiplierMax float64 `json:"downloadMultiplierMax"`
	UploadMultiplierMin   float64 `json:"uploadMultiplierMin"`
	UploadMultiplierMax   float64 `json:"uploadMultiplierMax"`
	BonusKiBPerSecond     float64 `json:"bonusKiBPerSecond"`
	BonusChancePercent    float64 `json:"bonusChancePercent"`
	ReportDownloadAsZero  bool    `json:"reportDownloadAsZero"`
	PretendToSeed         bool    `json:"pretendToSeed"`
	OnlyTrackerTraffic    bool    `json:"onlyTrackerTraffic"`
	OnlyLocalConnections  bool    `json:"onlyLocalConnections"`
}

// TrackerResearchSettingsUpdate requires the complete public settings object.
// AcknowledgedRisk is deliberately never persisted.
type TrackerResearchSettingsUpdate struct {
	Enabled               bool    `json:"enabled"`
	MinimumLeechers       int     `json:"minimumLeechers"`
	DownloadMultiplierMin float64 `json:"downloadMultiplierMin"`
	DownloadMultiplierMax float64 `json:"downloadMultiplierMax"`
	UploadMultiplierMin   float64 `json:"uploadMultiplierMin"`
	UploadMultiplierMax   float64 `json:"uploadMultiplierMax"`
	BonusKiBPerSecond     float64 `json:"bonusKiBPerSecond"`
	BonusChancePercent    float64 `json:"bonusChancePercent"`
	ReportDownloadAsZero  bool    `json:"reportDownloadAsZero"`
	PretendToSeed         bool    `json:"pretendToSeed"`
	OnlyTrackerTraffic    bool    `json:"onlyTrackerTraffic"`
	OnlyLocalConnections  bool    `json:"onlyLocalConnections"`
	AcknowledgedRisk      bool    `json:"acknowledgedRisk"`
}

// TrackerResearchSnapshot exposes operational state without tracker URLs,
// passkeys, info hashes, or relay tokens.
type TrackerResearchSnapshot struct {
	TrackerResearchSettings
	Warning               string   `json:"warning"`
	SupportedTransports   []string `json:"supportedTransports"`
	UnsupportedTransports []string `json:"unsupportedTransports"`
	UpdatePolicy          string   `json:"updatePolicy"`
	SupportKnown          bool     `json:"supportKnown"`
	Supported             bool     `json:"supported"`
	Active                bool     `json:"active"`
	ConfiguredTorrents    int      `json:"configuredTorrents"`
	RewrittenTrackers     int      `json:"rewrittenTrackers"`
	ForwardedAnnounces    uint64   `json:"forwardedAnnounces"`
	LastError             string   `json:"lastError,omitempty"`
}

type btTrackerConfig struct {
	URL  string `json:"url"`
	Tier int    `json:"tier"`
}

type trackerResearchRPC interface {
	supportsTrackerResearch() (bool, error)
	replaceBtTrackers(string, []btTrackerConfig) error
}

type trackerResearchDiskState struct {
	SchemaVersion int                          `json:"schemaVersion"`
	Settings      TrackerResearchSettings      `json:"settings"`
	Originals     map[string][]btTrackerConfig `json:"originalTrackers,omitempty"`
}

type trackerRelayBinding struct {
	original *url.URL
}

type trackerTorrentRewrite struct {
	replacementCount int
	tokens           []string
}

type trackerAnnounceState struct {
	actualSeen       bool
	actualDownloaded int64
	actualUploaded   int64
	firstLeft        int64
	firstLeftSet     bool
	reportedSeen     bool
	reportedUploaded int64
	lastReportedAt   time.Time
	lastIncomplete   int64
}

type trackerResearchModule struct {
	mu sync.Mutex

	path      string
	settings  TrackerResearchSettings
	originals map[string][]btTrackerConfig
	rewrites  map[string]trackerTorrentRewrite
	bindings  map[string]trackerRelayBinding
	announces map[string]*trackerAnnounceState

	supportKnown       bool
	supported          bool
	lastError          string
	forwardedAnnounces uint64

	listener net.Listener
	server   *http.Server
	client   *http.Client
	now      func() time.Time
	random   func() float64
}

func defaultTrackerResearchSettings() TrackerResearchSettings {
	return TrackerResearchSettings{
		MinimumLeechers:       3,
		DownloadMultiplierMin: 0,
		DownloadMultiplierMax: 0.001,
		UploadMultiplierMin:   2,
		UploadMultiplierMax:   8,
		BonusKiBPerSecond:     15,
		BonusChancePercent:    5,
		OnlyTrackerTraffic:    true,
		OnlyLocalConnections:  true,
	}
}

func newTrackerResearchModule(databasePath string) (*trackerResearchModule, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	module := &trackerResearchModule{
		path:      filepath.Join(filepath.Dir(databasePath), "truedown.tracker-research.json"),
		settings:  defaultTrackerResearchSettings(),
		originals: make(map[string][]btTrackerConfig),
		rewrites:  make(map[string]trackerTorrentRewrite),
		bindings:  make(map[string]trackerRelayBinding),
		announces: make(map[string]*trackerAnnounceState),
		client: &http.Client{
			Timeout:   20 * time.Second,
			Transport: transport,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		now:    time.Now,
		random: func() float64 { return float64(randomUint53()) / float64(uint64(1)<<53) },
	}
	data, err := os.ReadFile(module.path)
	if os.IsNotExist(err) {
		return module, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read tracker research settings: %w", err)
	}
	var state trackerResearchDiskState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("decode tracker research settings: %w", err)
	}
	if state.SchemaVersion != 1 {
		return nil, fmt.Errorf("unsupported tracker research settings schema %d", state.SchemaVersion)
	}
	normalized, err := normalizeTrackerResearchSettings(state.Settings)
	if err != nil {
		return nil, fmt.Errorf("validate tracker research settings: %w", err)
	}
	module.settings = normalized
	for gid, trackers := range state.Originals {
		if !validTrackerResearchGID(gid) {
			return nil, fmt.Errorf("validate tracker research state: invalid GID")
		}
		normalizedTrackers, err := normalizeOriginalTrackers(trackers)
		if err != nil {
			return nil, fmt.Errorf("validate tracker research state: %w", err)
		}
		module.originals[gid] = normalizedTrackers
	}
	return module, nil
}

func normalizeTrackerResearchSettings(settings TrackerResearchSettings) (TrackerResearchSettings, error) {
	invalid := func(message string) (TrackerResearchSettings, error) {
		return TrackerResearchSettings{}, &ValidationError{Message: message}
	}
	if settings.MinimumLeechers < 0 || settings.MinimumLeechers > 1_000_000 {
		return invalid("minimumLeechers must be between 0 and 1000000")
	}
	for name, value := range map[string]float64{
		"downloadMultiplierMin": settings.DownloadMultiplierMin,
		"downloadMultiplierMax": settings.DownloadMultiplierMax,
		"uploadMultiplierMin":   settings.UploadMultiplierMin,
		"uploadMultiplierMax":   settings.UploadMultiplierMax,
	} {
		if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > 1000 {
			return invalid(name + " must be between 0 and 1000")
		}
	}
	if settings.DownloadMultiplierMin > settings.DownloadMultiplierMax {
		return invalid("downloadMultiplierMin must not exceed downloadMultiplierMax")
	}
	if settings.UploadMultiplierMin > settings.UploadMultiplierMax {
		return invalid("uploadMultiplierMin must not exceed uploadMultiplierMax")
	}
	if math.IsNaN(settings.BonusKiBPerSecond) || math.IsInf(settings.BonusKiBPerSecond, 0) ||
		settings.BonusKiBPerSecond < 0 || settings.BonusKiBPerSecond > 1_000_000 {
		return invalid("bonusKiBPerSecond must be between 0 and 1000000")
	}
	if math.IsNaN(settings.BonusChancePercent) || math.IsInf(settings.BonusChancePercent, 0) ||
		settings.BonusChancePercent < 0 || settings.BonusChancePercent > 100 {
		return invalid("bonusChancePercent must be between 0 and 100")
	}
	if !settings.OnlyTrackerTraffic || !settings.OnlyLocalConnections {
		return invalid("tracker research relay must remain tracker-only and local-only")
	}
	if settings.PretendToSeed {
		settings.ReportDownloadAsZero = true
	}
	return settings, nil
}

func normalizeOriginalTrackers(trackers []btTrackerConfig) ([]btTrackerConfig, error) {
	if len(trackers) == 0 || len(trackers) > 256 {
		return nil, errors.New("original tracker list must contain 1 to 256 entries")
	}
	normalized := make([]btTrackerConfig, 0, len(trackers))
	for _, tracker := range trackers {
		if tracker.Tier < 0 || tracker.Tier > 255 || len(tracker.URL) == 0 || len(tracker.URL) > 4096 {
			return nil, errors.New("invalid original tracker entry")
		}
		parsed, err := url.Parse(tracker.URL)
		if err != nil || parsed.Scheme == "" {
			return nil, errors.New("invalid original tracker URL")
		}
		normalized = append(normalized, tracker)
	}
	return normalized, nil
}

func validTrackerResearchGID(gid string) bool {
	if len(gid) != 16 {
		return false
	}
	_, err := hex.DecodeString(gid)
	return err == nil
}

func (module *trackerResearchModule) persistLocked() error {
	state := trackerResearchDiskState{
		SchemaVersion: 1,
		Settings:      module.settings,
		Originals:     module.originals,
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("encode tracker research settings: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(module.path), 0700); err != nil {
		return fmt.Errorf("create tracker research settings directory: %w", err)
	}
	if err := os.WriteFile(module.path, append(data, '\n'), 0600); err != nil {
		return fmt.Errorf("persist tracker research settings: %w", err)
	}
	return nil
}

func (module *trackerResearchModule) snapshot() TrackerResearchSnapshot {
	module.mu.Lock()
	defer module.mu.Unlock()
	rewritten := 0
	for _, rewrite := range module.rewrites {
		rewritten += rewrite.replacementCount
	}
	return TrackerResearchSnapshot{
		TrackerResearchSettings: module.settings,
		Warning:                 trackerResearchWarning,
		SupportedTransports:     []string{"http", "https"},
		UnsupportedTransports:   []string{"udp"},
		UpdatePolicy:            "follows-truedown",
		SupportKnown:            module.supportKnown,
		Supported:               module.supported,
		Active:                  module.settings.Enabled && module.supported && module.server != nil,
		ConfiguredTorrents:      len(module.rewrites),
		RewrittenTrackers:       rewritten,
		ForwardedAnnounces:      module.forwardedAnnounces,
		LastError:               module.lastError,
	}
}

func trackerSettingsFromUpdate(update TrackerResearchSettingsUpdate) TrackerResearchSettings {
	return TrackerResearchSettings{
		Enabled:               update.Enabled,
		MinimumLeechers:       update.MinimumLeechers,
		DownloadMultiplierMin: update.DownloadMultiplierMin,
		DownloadMultiplierMax: update.DownloadMultiplierMax,
		UploadMultiplierMin:   update.UploadMultiplierMin,
		UploadMultiplierMax:   update.UploadMultiplierMax,
		BonusKiBPerSecond:     update.BonusKiBPerSecond,
		BonusChancePercent:    update.BonusChancePercent,
		ReportDownloadAsZero:  update.ReportDownloadAsZero,
		PretendToSeed:         update.PretendToSeed,
		OnlyTrackerTraffic:    update.OnlyTrackerTraffic,
		OnlyLocalConnections:  update.OnlyLocalConnections,
	}
}

func (module *trackerResearchModule) setSettings(settings TrackerResearchSettings) error {
	module.mu.Lock()
	previous := module.settings
	module.settings = settings
	if err := module.persistLocked(); err != nil {
		module.settings = previous
		module.mu.Unlock()
		return err
	}
	module.lastError = ""
	module.mu.Unlock()
	return nil
}

func (module *trackerResearchModule) prepare(rpc ariaRPC) error {
	if err := module.inspectSupport(rpc); err != nil {
		return err
	}
	if err := module.startRelay(); err != nil {
		module.setLastError(err)
		return err
	}
	return nil
}

func (module *trackerResearchModule) inspectSupport(rpc ariaRPC) error {
	researchRPC, ok := rpc.(trackerResearchRPC)
	if !ok {
		module.setSupport(false, errors.New("the active engine does not expose aria2.replaceBtTrackers; select Aria2 Next and restart TrueDown"))
		return &ValidationError{Message: "tracker research requires Aria2 Next; select it and restart TrueDown"}
	}
	supported, err := researchRPC.supportsTrackerResearch()
	if err != nil {
		module.setSupport(false, fmt.Errorf("check Aria2 Next tracker RPC support: %w", err))
		return fmt.Errorf("check Aria2 Next tracker RPC support: %w", err)
	}
	if !supported {
		module.setSupport(false, errors.New("the active engine does not support aria2.replaceBtTrackers"))
		return &ValidationError{Message: "tracker research requires an Aria2 Next build with aria2.replaceBtTrackers"}
	}
	module.setSupport(true, nil)
	return nil
}

func (module *trackerResearchModule) setSupport(supported bool, err error) {
	module.mu.Lock()
	defer module.mu.Unlock()
	module.supportKnown = true
	module.supported = supported
	module.lastError = errorText(err)
}

func (module *trackerResearchModule) setLastError(err error) {
	module.mu.Lock()
	defer module.mu.Unlock()
	module.lastError = errorText(err)
}

func errorText(err error) string {
	if err == nil {
		return ""
	}
	return truncateText(err.Error(), 1024)
}

func (module *trackerResearchModule) startRelay() error {
	module.mu.Lock()
	defer module.mu.Unlock()
	if module.server != nil {
		return nil
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("start local tracker research relay: %w", err)
	}
	server := &http.Server{
		Handler:           module,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      25 * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    32 * 1024,
	}
	module.listener = listener
	module.server = server
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			module.setLastError(fmt.Errorf("local tracker research relay stopped: %w", err))
		}
	}()
	return nil
}

func (module *trackerResearchModule) relayBaseURL() string {
	module.mu.Lock()
	defer module.mu.Unlock()
	if module.listener == nil {
		return ""
	}
	return "http://" + module.listener.Addr().String() + "/tracker/"
}

func (module *trackerResearchModule) close() {
	module.mu.Lock()
	server := module.server
	module.server = nil
	module.listener = nil
	module.bindings = make(map[string]trackerRelayBinding)
	module.rewrites = make(map[string]trackerTorrentRewrite)
	module.announces = make(map[string]*trackerAnnounceState)
	module.mu.Unlock()
	if server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}
}

func (module *trackerResearchModule) maybeCloseRelay() {
	module.mu.Lock()
	shouldClose := !module.settings.Enabled && len(module.rewrites) == 0
	server := module.server
	if shouldClose {
		module.server = nil
		module.listener = nil
		module.bindings = make(map[string]trackerRelayBinding)
		module.announces = make(map[string]*trackerAnnounceState)
	}
	module.mu.Unlock()
	if shouldClose && server != nil {
		_ = server.Close()
	}
}

func (module *trackerResearchModule) sync(rpc ariaRPC, statuses []ariaStatus) {
	researchRPC, ok := rpc.(trackerResearchRPC)
	if !ok {
		return
	}
	module.mu.Lock()
	enabled := module.settings.Enabled
	supported := module.supported
	module.mu.Unlock()
	if !enabled {
		module.restoreAll(researchRPC)
		module.maybeCloseRelay()
		return
	}
	if !supported {
		return
	}
	if err := module.startRelay(); err != nil {
		module.setLastError(err)
		return
	}
	for _, status := range statuses {
		if status.Bittorrent == nil || len(status.Bittorrent.AnnounceList) == 0 {
			continue
		}
		module.ensureRewrite(researchRPC, status.GID, status.Bittorrent.AnnounceList)
	}
}

func (module *trackerResearchModule) ensureRewrite(rpc trackerResearchRPC, gid string, announceList [][]string) {
	module.mu.Lock()
	if _, ok := module.rewrites[gid]; ok {
		module.mu.Unlock()
		return
	}
	originals, known := module.originals[gid]
	module.mu.Unlock()
	if !known {
		originals = flattenAnnounceList(announceList)
	}
	if len(originals) == 0 {
		return
	}
	replacement, bindings, tokens := module.buildReplacement(originals)
	if len(tokens) == 0 {
		return
	}
	if !known {
		module.mu.Lock()
		module.originals[gid] = cloneTrackerConfigs(originals)
		if err := module.persistLocked(); err != nil {
			delete(module.originals, gid)
			module.lastError = errorText(err)
			module.mu.Unlock()
			return
		}
		module.mu.Unlock()
	}
	module.mu.Lock()
	for token, binding := range bindings {
		module.bindings[token] = binding
	}
	module.mu.Unlock()
	if err := rpc.replaceBtTrackers(gid, replacement); err != nil {
		module.mu.Lock()
		for _, token := range tokens {
			delete(module.bindings, token)
		}
		module.lastError = errorText(fmt.Errorf("replace BitTorrent trackers: %w", err))
		module.mu.Unlock()
		return
	}
	module.mu.Lock()
	module.rewrites[gid] = trackerTorrentRewrite{replacementCount: len(tokens), tokens: tokens}
	module.lastError = ""
	module.mu.Unlock()
}

func flattenAnnounceList(announceList [][]string) []btTrackerConfig {
	trackers := make([]btTrackerConfig, 0)
	for tier, urls := range announceList {
		for _, rawURL := range urls {
			if len(trackers) >= 256 || len(rawURL) == 0 || len(rawURL) > 4096 {
				continue
			}
			trackers = append(trackers, btTrackerConfig{URL: rawURL, Tier: tier})
		}
	}
	return trackers
}

func (module *trackerResearchModule) buildReplacement(originals []btTrackerConfig) ([]btTrackerConfig, map[string]trackerRelayBinding, []string) {
	baseURL := module.relayBaseURL()
	replacement := make([]btTrackerConfig, 0, len(originals))
	bindings := make(map[string]trackerRelayBinding)
	tokens := make([]string, 0)
	for _, tracker := range originals {
		parsed, err := url.Parse(tracker.URL)
		if err != nil || parsed.User != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			replacement = append(replacement, tracker)
			continue
		}
		token, err := newTrackerRelayToken()
		if err != nil {
			replacement = append(replacement, tracker)
			continue
		}
		bindings[token] = trackerRelayBinding{original: parsed}
		tokens = append(tokens, token)
		replacement = append(replacement, btTrackerConfig{URL: baseURL + token, Tier: tracker.Tier})
	}
	return replacement, bindings, tokens
}

func newTrackerRelayToken() (string, error) {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

func cloneTrackerConfigs(trackers []btTrackerConfig) []btTrackerConfig {
	return append([]btTrackerConfig(nil), trackers...)
}

func (module *trackerResearchModule) restoreAll(rpc trackerResearchRPC) {
	module.mu.Lock()
	gids := make([]string, 0, len(module.originals))
	for gid := range module.originals {
		gids = append(gids, gid)
	}
	module.mu.Unlock()
	for _, gid := range gids {
		module.restore(rpc, gid)
	}
}

func (module *trackerResearchModule) restoreAllIfSupported(rpc ariaRPC) {
	researchRPC, ok := rpc.(trackerResearchRPC)
	if ok {
		module.restoreAll(researchRPC)
	}
}

func (module *trackerResearchModule) restore(rpc trackerResearchRPC, gid string) {
	module.mu.Lock()
	originals, ok := module.originals[gid]
	module.mu.Unlock()
	if !ok {
		return
	}
	if err := rpc.replaceBtTrackers(gid, originals); err != nil && !isGIDNotFound(err) {
		module.setLastError(fmt.Errorf("restore BitTorrent trackers: %w", err))
		return
	}
	module.mu.Lock()
	if rewrite, ok := module.rewrites[gid]; ok {
		for _, token := range rewrite.tokens {
			delete(module.bindings, token)
		}
		delete(module.rewrites, gid)
	}
	delete(module.originals, gid)
	if err := module.persistLocked(); err != nil {
		module.lastError = errorText(err)
	} else {
		module.lastError = ""
	}
	module.mu.Unlock()
}

func (module *trackerResearchModule) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	remoteHost, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil || net.ParseIP(remoteHost) == nil || !net.ParseIP(remoteHost).IsLoopback() {
		http.Error(response, "local tracker requests only", http.StatusForbidden)
		return
	}
	module.mu.Lock()
	listener := module.listener
	module.mu.Unlock()
	if listener == nil || request.Host != listener.Addr().String() {
		http.Error(response, "invalid relay host", http.StatusBadRequest)
		return
	}
	token := strings.TrimPrefix(request.URL.Path, "/tracker/")
	if token == request.URL.Path || token == "" || strings.Contains(token, "/") {
		http.NotFound(response, request)
		return
	}
	module.mu.Lock()
	binding, ok := module.bindings[token]
	module.mu.Unlock()
	if !ok {
		http.NotFound(response, request)
		return
	}
	query, err := url.ParseQuery(request.URL.RawQuery)
	if err != nil || len(query["info_hash"]) == 0 {
		http.Error(response, "tracker query required", http.StatusBadRequest)
		return
	}
	target := *binding.original
	targetQuery := target.Query()
	for key, values := range query {
		targetQuery.Del(key)
		for _, value := range values {
			targetQuery.Add(key, value)
		}
	}
	announceKey := token + "\x00" + query.Get("info_hash")
	module.rewriteAnnounce(targetQuery, announceKey)
	target.RawQuery = targetQuery.Encode()
	outbound, err := http.NewRequestWithContext(request.Context(), http.MethodGet, target.String(), nil)
	if err != nil {
		http.Error(response, "invalid tracker request", http.StatusBadGateway)
		return
	}
	if value := request.Header.Get("User-Agent"); value != "" {
		outbound.Header.Set("User-Agent", value)
	}
	if value := request.Header.Get("Accept"); value != "" {
		outbound.Header.Set("Accept", value)
	}
	outbound.Header.Set("Accept-Encoding", "identity")
	upstream, err := module.client.Do(outbound)
	if err != nil {
		// net/http errors can contain the full passkey-bearing tracker URL.
		module.setLastError(errors.New("forward tracker request failed"))
		http.Error(response, "tracker request failed", http.StatusBadGateway)
		return
	}
	defer upstream.Body.Close()
	body, err := io.ReadAll(io.LimitReader(upstream.Body, trackerRelayBodyLimit+1))
	if err != nil || len(body) > trackerRelayBodyLimit {
		module.setLastError(errors.New("tracker response exceeds relay limit or could not be read"))
		http.Error(response, "tracker response unavailable", http.StatusBadGateway)
		return
	}
	if incomplete, ok := bencodeDictionaryInt(body, "incomplete"); ok && incomplete >= 0 {
		module.mu.Lock()
		state := module.announces[announceKey]
		if state == nil {
			state = &trackerAnnounceState{}
			module.announces[announceKey] = state
		}
		state.lastIncomplete = incomplete
		module.mu.Unlock()
	}
	copyTrackerResponseHeaders(response.Header(), upstream.Header)
	response.WriteHeader(upstream.StatusCode)
	_, _ = response.Write(body)
	module.mu.Lock()
	module.forwardedAnnounces++
	module.lastError = ""
	module.mu.Unlock()
}

func (module *trackerResearchModule) rewriteAnnounce(query url.Values, announceKey string) {
	downloaded, downOK := parseNonNegativeInt64(query.Get("downloaded"))
	uploaded, upOK := parseNonNegativeInt64(query.Get("uploaded"))
	left, leftOK := parseNonNegativeInt64(query.Get("left"))
	if !downOK || !upOK || !leftOK {
		return
	}
	event := query.Get("event")
	now := module.now()
	module.mu.Lock()
	defer module.mu.Unlock()
	settings := module.settings
	if !settings.Enabled {
		return
	}
	state := module.announces[announceKey]
	if state == nil {
		state = &trackerAnnounceState{}
		module.announces[announceKey] = state
	}
	if !state.firstLeftSet {
		state.firstLeft = left
		state.firstLeftSet = true
	}
	actualDownDelta, actualUpDelta := downloaded, uploaded
	if state.actualSeen && event != "started" {
		actualDownDelta = nonNegativeDelta(downloaded, state.actualDownloaded)
		actualUpDelta = nonNegativeDelta(uploaded, state.actualUploaded)
	}
	state.actualSeen = true
	state.actualDownloaded = downloaded
	state.actualUploaded = uploaded
	previousReportedUpload := int64(0)
	elapsedSeconds := float64(0)
	if state.reportedSeen && event != "started" {
		previousReportedUpload = state.reportedUploaded
		elapsedSeconds = now.Sub(state.lastReportedAt).Seconds()
		if elapsedSeconds < 0 {
			elapsedSeconds = 0
		}
	}
	if settings.ReportDownloadAsZero {
		query.Set("downloaded", "0")
		query.Set("left", strconv.FormatInt(state.firstLeft, 10))
		if settings.PretendToSeed {
			query.Set("left", "0")
		}
		if event == "completed" {
			query.Del("event")
		}
	}
	reportedUpload := float64(previousReportedUpload) + float64(actualUpDelta)
	if state.lastIncomplete >= int64(settings.MinimumLeechers) {
		downMultiplier := randomBetween(module.random(), settings.DownloadMultiplierMin, settings.DownloadMultiplierMax)
		upMultiplier := randomBetween(module.random(), settings.UploadMultiplierMin, settings.UploadMultiplierMax)
		reportedUpload += downMultiplier*float64(actualDownDelta) + upMultiplier*float64(actualUpDelta)
		if module.random()*100 < settings.BonusChancePercent {
			reportedUpload += settings.BonusKiBPerSecond * 1024 * elapsedSeconds * module.random()
		}
	}
	if reportedUpload < float64(previousReportedUpload) {
		reportedUpload = float64(previousReportedUpload)
	}
	maxReportedUpload := math.Nextafter(float64(math.MaxInt64), 0)
	if reportedUpload > maxReportedUpload {
		reportedUpload = maxReportedUpload
	}
	reported := int64(math.Round(reportedUpload))
	query.Set("uploaded", strconv.FormatInt(reported, 10))
	state.reportedSeen = true
	state.reportedUploaded = reported
	state.lastReportedAt = now
}

func parseNonNegativeInt64(value string) (int64, bool) {
	parsed, err := strconv.ParseInt(value, 10, 64)
	return parsed, err == nil && parsed >= 0
}

func nonNegativeDelta(current, previous int64) int64 {
	if current < previous {
		return 0
	}
	return current - previous
}

func randomBetween(randomValue, minimum, maximum float64) float64 {
	return minimum + randomValue*(maximum-minimum)
}

func randomUint53() uint64 {
	buffer := make([]byte, 8)
	if _, err := rand.Read(buffer); err != nil {
		return uint64(time.Now().UnixNano()) & ((uint64(1) << 53) - 1)
	}
	value := uint64(0)
	for _, item := range buffer {
		value = value<<8 | uint64(item)
	}
	return value & ((uint64(1) << 53) - 1)
}

func copyTrackerResponseHeaders(destination, source http.Header) {
	for _, name := range []string{"Content-Type", "Content-Encoding", "Cache-Control", "Expires", "Retry-After"} {
		for _, value := range source.Values(name) {
			destination.Add(name, value)
		}
	}
	destination.Del("Content-Length")
}

func bencodeDictionaryInt(data []byte, wanted string) (int64, bool) {
	position := 0
	if len(data) == 0 || data[position] != 'd' {
		return 0, false
	}
	position++
	for position < len(data) && data[position] != 'e' {
		key, ok := bencodeBytes(data, &position)
		if !ok {
			return 0, false
		}
		if string(key) == wanted {
			return bencodeInt(data, &position)
		}
		if !skipBencodeValue(data, &position, 0) {
			return 0, false
		}
	}
	return 0, false
}

func bencodeBytes(data []byte, position *int) ([]byte, bool) {
	start := *position
	for *position < len(data) && data[*position] >= '0' && data[*position] <= '9' {
		*position++
	}
	if start == *position || *position >= len(data) || data[*position] != ':' {
		return nil, false
	}
	length, err := strconv.Atoi(string(data[start:*position]))
	if err != nil || length < 0 {
		return nil, false
	}
	*position++
	end := *position + length
	if end < *position || end > len(data) {
		return nil, false
	}
	value := data[*position:end]
	*position = end
	return value, true
}

func bencodeInt(data []byte, position *int) (int64, bool) {
	if *position >= len(data) || data[*position] != 'i' {
		return 0, false
	}
	*position++
	start := *position
	for *position < len(data) && data[*position] != 'e' {
		*position++
	}
	if start == *position || *position >= len(data) {
		return 0, false
	}
	value, err := strconv.ParseInt(string(data[start:*position]), 10, 64)
	*position++
	return value, err == nil
}

func skipBencodeValue(data []byte, position *int, depth int) bool {
	if depth > 32 || *position >= len(data) {
		return false
	}
	switch data[*position] {
	case 'i':
		_, ok := bencodeInt(data, position)
		return ok
	case 'l', 'd':
		kind := data[*position]
		*position++
		for *position < len(data) && data[*position] != 'e' {
			if kind == 'd' {
				if _, ok := bencodeBytes(data, position); !ok {
					return false
				}
			}
			if !skipBencodeValue(data, position, depth+1) {
				return false
			}
		}
		if *position >= len(data) {
			return false
		}
		*position++
		return true
	default:
		_, ok := bencodeBytes(data, position)
		return ok
	}
}

// TrackerResearchSettings returns both saved model values and safe runtime state.
func (m *Manager) TrackerResearchSettings() TrackerResearchSnapshot {
	return m.trackerResearch.snapshot()
}

// UpdateTrackerResearchSettings validates explicit consent before first enable.
func (m *Manager) UpdateTrackerResearchSettings(update TrackerResearchSettingsUpdate) (TrackerResearchSnapshot, error) {
	normalized, err := normalizeTrackerResearchSettings(trackerSettingsFromUpdate(update))
	if err != nil {
		return TrackerResearchSnapshot{}, err
	}
	m.opMu.Lock()
	defer m.opMu.Unlock()
	current := m.trackerResearch.snapshot().TrackerResearchSettings
	if normalized.Enabled && !current.Enabled && !update.AcknowledgedRisk {
		return TrackerResearchSnapshot{}, &ValidationError{Message: "acknowledgedRisk must be true when enabling tracker research"}
	}
	if normalized.Enabled && !current.Enabled {
		if m.rpc == nil {
			return TrackerResearchSnapshot{}, &ValidationError{Message: "aria2 is not running"}
		}
		if err := m.trackerResearch.prepare(m.rpc); err != nil {
			return TrackerResearchSnapshot{}, err
		}
	}
	if err := m.trackerResearch.setSettings(normalized); err != nil {
		m.trackerResearch.maybeCloseRelay()
		return TrackerResearchSnapshot{}, err
	}
	if current.Enabled && !normalized.Enabled && m.rpc != nil {
		m.trackerResearch.restoreAllIfSupported(m.rpc)
		m.trackerResearch.maybeCloseRelay()
	}
	if m.rpc != nil {
		if statuses, statusErr := m.rpc.statuses(); statusErr == nil {
			m.trackerResearch.sync(m.rpc, statuses)
		} else {
			m.trackerResearch.setLastError(fmt.Errorf("refresh tracker research state: %w", statusErr))
		}
	}
	return m.trackerResearch.snapshot(), nil
}
