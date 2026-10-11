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
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 20 * time.Second
	transport.MaxConnsPerHost = 2
	return &Client{http: &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, gateway: "https://g.api.mega.co.nz/cs?id=1"}
}

func (c *Client) SetProxy(raw string) error {
	transport, ok := c.http.Transport.(*http.Transport)
	if !ok {
		return ErrSource
	}
	var proxy *url.URL
	if raw != "" {
		var err error
		proxy, err = url.Parse(raw)
		if err != nil || proxy.Hostname() == "" || len(raw) > 4096 || (proxy.Scheme != "http" && proxy.Scheme != "https" && proxy.Scheme != "socks5" && proxy.Scheme != "socks5h") {
			return ErrSource
		}
	}
	transport.CloseIdleConnections()
	transport.Proxy = http.ProxyURL(proxy)
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
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	body, _ := json.Marshal([]any{map[string]any{"a": "g", "g": 1, "p": link.Handle, "ssl": 2}})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.gateway, bytes.NewReader(body))
	if err != nil {
		return Metadata{}, ErrNetwork
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "TrueDown-MEGA/0.1.0")
	response, err := c.http.Do(request)
	if err != nil {
		return Metadata{}, ErrNetwork
	}
	defer response.Body.Close()
	if response.StatusCode == 429 || response.StatusCode == 509 {
		return Metadata{}, ErrQuota
	}
	if response.StatusCode != 200 {
		return Metadata{}, ErrNetwork
	}
	// A challenge requires a separate bounded proof-of-work implementation.
	if response.Header.Get("X-Hashcash") != "" {
		return Metadata{}, ErrUnsupported
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 128*1024+1))
	if err != nil || len(data) > 128*1024 {
		return Metadata{}, ErrNetwork
	}
	var entries []json.RawMessage
	if json.Unmarshal(data, &entries) != nil || len(entries) != 1 {
		return Metadata{}, ErrNetwork
	}
	var code int
	if json.Unmarshal(entries[0], &code) == nil {
		if code == -17 || code == -24 || code == -4 {
			return Metadata{}, ErrQuota
		}
		if code == -9 || code == -2 || code == -11 {
			return Metadata{}, ErrSource
		}
		return Metadata{}, ErrNetwork
	}
	var value struct {
		URL        json.RawMessage `json:"g"`
		Size       *int64          `json:"s"`
		Attributes string          `json:"at"`
	}
	if json.Unmarshal(entries[0], &value) != nil || value.Size == nil || *value.Size < 0 || *value.Size > 1<<50 {
		return Metadata{}, ErrNetwork
	}
	var direct string
	if json.Unmarshal(value.URL, &direct) != nil {
		return Metadata{}, ErrUnsupported
	} // CloudRAID needs its own implementation.
	if !allowedDownload(direct) {
		return Metadata{}, ErrNetwork
	}
	name, err := link.DecryptAttributes(value.Attributes)
	if err != nil {
		return Metadata{}, err
	}
	return Metadata{Name: name, Size: *value.Size, URL: direct}, nil
}
