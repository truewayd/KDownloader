package mega

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"truedown/internal/netproxy"
)

type Metadata struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	URL  string `json:"-"`
}

type Client struct {
	http    *http.Client
	gateway string
}

func NewClient() *Client {
	transport := netproxy.NewTransport(netproxy.System)
	transport.ResponseHeaderTimeout = 20 * time.Second
	transport.MaxConnsPerHost = 2
	return &Client{http: &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, gateway: "https://g.api.mega.co.nz/cs?id=1"}
}

func (c *Client) SetProxy(raw string) error {
	transport, ok := c.http.Transport.(*http.Transport)
	if !ok {
		return ErrSource
	}
	proxy, err := netproxy.Resolved(raw)
	if err != nil {
		return ErrSource
	}
	transport.CloseIdleConnections()
	transport.Proxy = proxy
	return nil
}

func allowedDownload(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" || u.Port() != "" || len(raw) > 8192 {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return strings.HasSuffix(host, ".userstorage.mega.co.nz") || host == "userstorage.mega.co.nz" || strings.HasSuffix(host, ".userstorage.mega.nz")
}

func (c *Client) Resolve(ctx context.Context, link Link) (Metadata, error) {
	return c.resolve(ctx, link, "", FileData{})
}

func (c *Client) ResolveFile(ctx context.Context, source Source, data json.RawMessage) (Metadata, json.RawMessage, error) {
	if source.Folder != "" && len(data) == 0 {
		collection, err := c.ListFolder(ctx, source)
		if err != nil {
			return Metadata{}, nil, err
		}
		if source.NodeKind != "file" || len(collection.Entries) != 1 {
			return Metadata{}, nil, ErrSource
		}
		data = collection.Entries[0].Data
	}
	link, file, err := FileLink(source, data)
	if err != nil {
		return Metadata{}, nil, err
	}
	metadata, err := c.resolve(ctx, link, source.Folder, file)
	return metadata, data, err
}

func (c *Client) resolve(ctx context.Context, link Link, folder string, file FileData) (Metadata, error) {
	command := map[string]any{"a": "g", "g": 1, "p": link.Handle, "ssl": 2}
	if folder != "" {
		delete(command, "p")
		command["n"] = link.Handle
	}
	var value struct {
		URL        json.RawMessage `json:"g"`
		Size       *int64          `json:"s"`
		Attributes string          `json:"at"`
	}
	if err := c.api(ctx, folder, command, 128*1024, &value); err != nil {
		return Metadata{}, err
	}
	if value.Size == nil || *value.Size < 0 || *value.Size > 1<<50 {
		return Metadata{}, ErrNetwork
	}
	var direct string
	if json.Unmarshal(value.URL, &direct) != nil {
		return Metadata{}, ErrUnsupported
	}
	if !allowedDownload(direct) {
		return Metadata{}, ErrNetwork
	}
	name := file.Name
	if value.Attributes != "" {
		var err error
		name, err = link.DecryptAttributes(value.Attributes)
		if err != nil {
			return Metadata{}, err
		}
	}
	if name == "" || (folder != "" && (file.Size != *value.Size || file.Name != name)) {
		return Metadata{}, ErrSource
	}
	return Metadata{Name: name, Size: *value.Size, URL: direct}, nil
}

func (c *Client) api(ctx context.Context, folder string, command map[string]any, limit int64, value any) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	body, _ := json.Marshal([]any{command})
	endpoint, err := url.Parse(c.gateway)
	if err != nil {
		return ErrSource
	}
	if folder != "" {
		query := endpoint.Query()
		query.Set("n", folder)
		endpoint.RawQuery = query.Encode()
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return ErrNetwork
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "TrueDown-MEGA/0.2.0")
	response, err := c.http.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return ErrNetwork
	}
	defer response.Body.Close()
	if response.StatusCode == 429 || response.StatusCode == 509 {
		return ErrQuota
	}
	if response.StatusCode != 200 {
		return ErrNetwork
	}
	// A challenge requires a separate bounded proof-of-work implementation.
	if response.Header.Get("X-Hashcash") != "" {
		return ErrUnsupported
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(data)) > limit {
		return ErrNetwork
	}
	var entries []json.RawMessage
	if json.Unmarshal(data, &entries) != nil || len(entries) != 1 {
		return ErrNetwork
	}
	var code int
	if json.Unmarshal(entries[0], &code) == nil {
		if code == -17 || code == -24 || code == -4 {
			return ErrQuota
		}
		if code == -9 || code == -2 || code == -11 {
			return ErrSource
		}
		return ErrNetwork
	}
	if json.Unmarshal(entries[0], value) != nil {
		return ErrNetwork
	}
	return nil
}
