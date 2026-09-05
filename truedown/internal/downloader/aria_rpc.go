package downloader

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

type ariaClient struct {
	url    string
	secret string
	http   *http.Client
	nextID atomic.Uint64
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
	resp, err := c.http.Post(c.url, "application/json", bytes.NewReader(body))
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
		Version string `json:"version"`
	}
	if err := c.call("aria2.getVersion", nil, &version); err != nil {
		return err
	}
	if strings.TrimSpace(version.Version) == "" {
		return fmt.Errorf("aria2 RPC returned an empty engine version")
	}
	return nil
}

func (c *ariaClient) addURI(t *Task, options map[string]any) error {
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
	var result string
	return c.call("aria2.pause", []any{gid}, &result)
}

func (c *ariaClient) unpause(gid string) error {
	var result string
	return c.call("aria2.unpause", []any{gid}, &result)
}

func (c *ariaClient) pauseAll() error {
	var result string
	return c.call("aria2.pauseAll", nil, &result)
}

func (c *ariaClient) unpauseAll() error {
	var result string
	return c.call("aria2.unpauseAll", nil, &result)
}

func (c *ariaClient) changeGlobalOptions(options map[string]string) error {
	var result string
	return c.call("aria2.changeGlobalOption", []any{options}, &result)
}

func (c *ariaClient) forceRemove(gid string) error {
	var result string
	return c.call("aria2.forceRemove", []any{gid}, &result)
}

func (c *ariaClient) status(gid string) (ariaStatus, error) {
	keys := []string{"gid", "status", "files", "bittorrent", "followedBy", "following"}
	var status ariaStatus
	err := c.call("aria2.tellStatus", []any{gid, keys}, &status)
	return status, err
}

func (c *ariaClient) removeResult(gid string) error {
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
	keys := []string{"gid", "status", "totalLength", "completedLength", "downloadSpeed", "uploadSpeed", "connections", "numSeeders", "errorCode", "errorMessage", "files", "bittorrent", "followedBy", "following"}
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
