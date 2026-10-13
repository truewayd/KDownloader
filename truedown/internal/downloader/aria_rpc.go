package downloader

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

type ariaClient struct {
	url                string
	secret             string
	http               *http.Client
	nextID             atomic.Uint64
	filenameResolution atomic.Bool
	mediaSupport       atomic.Bool
	probeSupport       atomic.Bool
	collections        *collectionTransports
	lifecycleCtx       context.Context
}

type ariaRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type ariaBitTorrentError struct {
	Code        string `json:"code"`
	Kind        string `json:"kind"`
	Category    string `json:"category"`
	Message     string `json:"message"`
	Operation   string `json:"operation"`
	Recoverable string `json:"recoverable"`
}

type ariaBitTorrentStatus struct {
	AnnounceList      [][]string           `json:"announceList"`
	State             string               `json:"state"`
	NumPeers          string               `json:"numPeers"`
	ConnectingPeers   string               `json:"connectingPeers"`
	HandshakingPeers  string               `json:"handshakingPeers"`
	NumSeeds          string               `json:"numSeeds"`
	ConnectCandidates string               `json:"connectCandidates"`
	Availability      string               `json:"availability"`
	Error             *ariaBitTorrentError `json:"error,omitempty"`
}

func (e *ariaRPCError) Error() string {
	return fmt.Sprintf("aria2 RPC %d: %s", e.Code, e.Message)
}

type ariaStatus struct {
	GID             string   `json:"gid"`
	Status          string   `json:"status"`
	TotalLength     string   `json:"totalLength"`
	CompletedLength string   `json:"completedLength"`
	DownloadSpeed   string   `json:"downloadSpeed"`
	UploadSpeed     string   `json:"uploadSpeed"`
	Connections     string   `json:"connections"`
	NumSeeders      string   `json:"numSeeders"`
	ErrorCode       string   `json:"errorCode"`
	ErrorMessage    string   `json:"errorMessage"`
	FollowedBy      []string `json:"followedBy"`
	Following       string   `json:"following"`
	Files           []struct {
		Path string `json:"path"`
	} `json:"files"`
	Bittorrent *ariaBitTorrentStatus `json:"bittorrent,omitempty"`
	Media      *ariaMediaStatus      `json:"media,omitempty"`
}

func newAriaClient(port int, secret string) *ariaClient {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.MaxIdleConns = 4
	transport.MaxIdleConnsPerHost = 4
	return &ariaClient{
		url:    fmt.Sprintf("http://127.0.0.1:%d/jsonrpc", port),
		secret: secret,
		http: &http.Client{
			Timeout:   8 * time.Second,
			Transport: transport,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

func (c *ariaClient) call(method string, params []any, result any) error {
	return c.callContext(context.Background(), method, params, result)
}

func (c *ariaClient) callContext(ctx context.Context, method string, params []any, result any) error {
	return c.callWithHTTP(ctx, c.http, method, params, result)
}

func (c *ariaClient) callWithHTTP(ctx context.Context, client *http.Client, method string, params []any, result any) error {
	requestParams := make([]any, 0, len(params)+1)
	requestParams = append(requestParams, "token:"+c.secret)
	requestParams = append(requestParams, params...)
	body, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      c.nextID.Add(1),
		"method":  method,
		"params":  requestParams,
	})
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(request)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 16*1024*1024+1))
	if err != nil {
		return fmt.Errorf("read aria2 RPC response: %w", err)
	}
	if len(data) > 16*1024*1024 {
		return fmt.Errorf("aria2 RPC response exceeds 16 MiB")
	}
	data = bytes.TrimSpace(data)
	if len(data) == 0 || data[0] != '{' {
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("aria2 RPC returned HTTP %d", resp.StatusCode)
		}
		return fmt.Errorf("aria2 RPC response must contain one JSON object")
	}
	var envelope struct {
		Result json.RawMessage `json:"result"`
		Error  *ariaRPCError   `json:"error"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("aria2 RPC returned HTTP %d", resp.StatusCode)
		}
		return fmt.Errorf("decode aria2 RPC response: %w", err)
	}
	if envelope.Error != nil {
		return envelope.Error
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("aria2 RPC returned HTTP %d", resp.StatusCode)
	}
	if result == nil {
		return nil
	}
	if err := json.Unmarshal(envelope.Result, result); err != nil {
		return fmt.Errorf("decode aria2 RPC result: %w", err)
	}
	return nil
}

func (c *ariaClient) ready() error {
	var version struct {
		Version          string   `json:"version"`
		DownloadFeatures []string `json:"downloadFeatures"`
		MediaFeatures    []string `json:"mediaFeatures"`
	}
	if err := c.call("aria2.getVersion", nil, &version); err != nil {
		return err
	}
	if strings.TrimSpace(version.Version) == "" {
		return fmt.Errorf("aria2 RPC returned an empty engine version")
	}
	supported := false
	for _, feature := range version.DownloadFeatures {
		supported = supported || feature == "filename-resolution"
	}
	// NEXT 3 no longer advertises downloadFeatures. Older engines retain the
	// feature flag as a fallback when method discovery is unavailable.
	var methods []string
	var retry, finish, probe bool
	if err := c.call("system.listMethods", nil, &methods); err == nil {
		supported = false
		for _, method := range methods {
			supported = supported || method == "aria2.resolveFilename"
			retry = retry || method == "aria2.retryMedia"
			finish = finish || method == "aria2.finishMedia"
			probe = probe || method == "aria2.probe"
		}
	}
	c.filenameResolution.Store(supported)
	var scopedHeaders, structuredErrors bool
	for _, feature := range version.MediaFeatures {
		scopedHeaders = scopedHeaders || feature == "request-contexts"
		structuredErrors = structuredErrors || feature == "structured-errors"
	}
	c.mediaSupport.Store(retry && finish && scopedHeaders && structuredErrors)
	c.probeSupport.Store(probe)
	return nil
}

func (c *ariaClient) capabilities() EngineCapabilities {
	return EngineCapabilities{Media: c.mediaSupport.Load(), Probe: c.probeSupport.Load()}
}

func (c *ariaClient) retryMedia(gid string, options map[string]any) error {
	var result string
	if err := c.call("aria2.retryMedia", []any{gid, options}, &result); err != nil {
		return err
	}
	if result != gid {
		return fmt.Errorf("aria2 returned an unexpected media GID")
	}
	return nil
}

func (c *ariaClient) finishMedia(gid string) error {
	var result string
	if err := c.call("aria2.finishMedia", []any{gid}, &result); err != nil {
		return err
	}
	if result != gid {
		return fmt.Errorf("aria2 returned an unexpected media GID")
	}
	return nil
}

func (c *ariaClient) resolveFilename(ctx context.Context, url, disposition string) (string, error) {
	if !c.filenameResolution.Load() {
		return "", nil
	}
	if len(url) > 16384 || len(disposition) > 8192 {
		return "", fmt.Errorf("filename metadata exceeds engine limits")
	}
	// []byte is encoded as base64 by encoding/json; the RPC needs integers.
	data := make([]int, len(disposition))
	for index := 0; index < len(disposition); index++ {
		data[index] = int(disposition[index])
	}
	var name string
	err := c.callContext(ctx, "aria2.resolveFilename", []any{url, data}, &name)
	return name, err
}

func (c *ariaClient) addURI(t *Task, options map[string]any) error {
	if c.collections != nil {
		if handled, err := c.collections.add(t, options); handled {
			return err
		}
	}
	return c.nativeAddURI(t, options)
}

func (c *ariaClient) nativeAddURI(t *Task, options map[string]any) error {
	params := []any{[]string{t.Link}, options}
	if t.QueueID > 0 {
		params = append(params, t.QueueID)
	}
	var gid string
	if err := c.call("aria2.addUri", params, &gid); err != nil {
		return err
	}
	if gid != t.GID {
		return fmt.Errorf("aria2 returned unexpected GID %q (wanted %q)", gid, t.GID)
	}
	return nil
}

func (c *ariaClient) addTorrent(t *Task, torrent string, options map[string]any) error {
	var gid string
	if err := c.call("aria2.addTorrent", []any{torrent, []string{}, options}, &gid); err != nil {
		return err
	}
	if gid != t.GID {
		return fmt.Errorf("aria2 returned unexpected GID %q (wanted %q)", gid, t.GID)
	}
	return nil
}

func (c *ariaClient) pause(gid string) error {
	if c.collections != nil {
		if handled, err := c.collections.control(gid, true); handled {
			return err
		}
	}
	return c.nativePause(gid)
}
func (c *ariaClient) nativePause(gid string) error {
	ctx, cancel := c.pauseContext()
	defer cancel()
	var result string
	if err := c.callContext(ctx, "aria2.pause", []any{gid}, &result); err != nil {
		return err
	}
	return c.waitForPause(ctx, gid)
}

func (c *ariaClient) unpause(gid string) error {
	if c.collections != nil {
		if handled, err := c.collections.control(gid, false); handled {
			return err
		}
	}
	return c.nativeUnpause(gid)
}
func (c *ariaClient) nativeUnpause(gid string) error {
	var result string
	return c.call("aria2.unpause", []any{gid}, &result)
}

func (c *ariaClient) pauseAll() error {
	if c.collections != nil {
		if err := c.collections.controlAll(true); err != nil {
			return err
		}
	}
	ctx, cancel := c.pauseContext()
	defer cancel()
	var result string
	if err := c.callContext(ctx, "aria2.pauseAll", nil, &result); err != nil {
		return err
	}
	return c.waitForPause(ctx, "")
}

func (c *ariaClient) unpauseAll() error {
	var result string
	if err := c.call("aria2.unpauseAll", nil, &result); err != nil {
		return err
	}
	if c.collections != nil {
		return c.collections.controlAll(false)
	}
	return nil
}

func (c *ariaClient) changeGlobalOptions(options map[string]string) error {
	var result string
	return c.call("aria2.changeGlobalOption", []any{options}, &result)
}

func (c *ariaClient) changeOptions(gid string, options map[string]string) error {
	if c.collections != nil {
		if job := c.collections.job(gid); job != nil {
			job.mu.Lock()
			defer job.mu.Unlock()
			if job.child != "" {
				if err := c.nativeChangeOptions(job.child, options); err != nil {
					return err
				}
			}
			for key, value := range options {
				job.options[key] = value
			}
			return nil
		}
	}
	return c.nativeChangeOptions(gid, options)
}
func (c *ariaClient) nativeChangeOptions(gid string, options map[string]string) error {
	var result string
	return c.call("aria2.changeOption", []any{gid, options}, &result)
}

func (c *ariaClient) forceRemove(gid string) error {
	if c.collections != nil && c.collections.job(gid) != nil {
		return c.collections.retire(gid, true)
	}
	return c.nativeForceRemove(gid)
}
func (c *ariaClient) nativeForceRemove(gid string) error {
	var result string
	return c.call("aria2.forceRemove", []any{gid}, &result)
}

func (c *ariaClient) status(gid string) (ariaStatus, error) {
	if c.collections != nil {
		if state, found := c.collections.state(gid); found {
			return state, nil
		}
	}
	return c.nativeStatus(gid)
}
func (c *ariaClient) nativeStatus(gid string) (ariaStatus, error) {
	keys := []string{"gid", "status", "files", "bittorrent", "media", "followedBy", "following", "totalLength", "completedLength", "downloadSpeed", "connections", "errorCode"}
	var status ariaStatus
	err := c.call("aria2.tellStatus", []any{gid, keys}, &status)
	return status, err
}

func (c *ariaClient) removeResult(gid string) error {
	if c.collections != nil && c.collections.job(gid) != nil {
		if err := c.collections.retire(gid, true); err != nil {
			return err
		}
		c.collections.forget(gid)
		return nil
	}
	return c.nativeRemoveResult(gid)
}
func (c *ariaClient) nativeRemoveResult(gid string) error {
	var result string
	return c.call("aria2.removeDownloadResult", []any{gid}, &result)
}

func (c *ariaClient) purgeResults() error {
	return c.call("aria2.purgeDownloadResult", nil, nil)
}

func (c *ariaClient) shutdown() error {
	defer c.http.CloseIdleConnections()
	var result string
	return c.call("aria2.shutdown", nil, &result)
}

func (c *ariaClient) statuses() ([]ariaStatus, error) {
	keys := []string{"gid", "status", "totalLength", "completedLength", "downloadSpeed", "uploadSpeed", "connections", "numSeeders", "errorCode", "errorMessage", "files", "bittorrent", "media", "followedBy", "following"}
	var active, waiting, stopped []ariaStatus
	if err := c.call("aria2.tellActive", []any{keys}, &active); err != nil {
		return nil, err
	}
	// Queued items are already known locally. A bounded window is enough to
	// observe aria2-side state without transferring thousands of stable rows
	// every second when a large batch is waiting.
	if err := c.call("aria2.tellWaiting", []any{0, ariaBacklogLimit, keys}, &waiting); err != nil {
		return nil, err
	}
	// Read newest results first; retained historical failures must not hide
	// current completions. Each admitted torrent can stop a metadata parent
	// and its child before the next poll.
	if err := c.call("aria2.tellStopped", []any{-1, ariaResultLimit, keys}, &stopped); err != nil {
		return nil, err
	}
	result := make([]ariaStatus, 0, len(active)+len(waiting)+len(stopped))
	result = append(result, active...)
	result = append(result, waiting...)
	result = append(result, stopped...)
	if c.collections != nil {
		result = c.collections.merge(result)
	}
	return result, nil
}

func (c *ariaClient) supportsTrackerResearch() (bool, error) {
	var methods []string
	if err := c.call("system.listMethods", nil, &methods); err != nil {
		return false, err
	}
	for _, method := range methods {
		if method == "aria2.replaceBtTrackers" {
			return true, nil
		}
	}
	return false, nil
}

func (c *ariaClient) replaceBtTrackers(gid string, trackers []btTrackerConfig) error {
	var result string
	return c.call("aria2.replaceBtTrackers", []any{gid, trackers}, &result)
}

func isGIDNotFound(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "gid") && strings.Contains(strings.ToLower(err.Error()), "not found")
}
