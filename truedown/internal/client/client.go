// Package client speaks only the public HTTP protocol; it cannot access tasks,
// launch aria2, or open the database.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"truedown/internal/protocol"
)

const MaxResponseBytes = 8 * 1024 * 1024

type Client struct {
	endpoint string
	token    string
	http     *http.Client
}

type HTTPError struct{ Status int }

func (e *HTTPError) Error() string {
	if e.Status == http.StatusUnauthorized {
		return "authentication required; configure TRUEDOWN_API_TOKEN or --data-dir"
	}
	return fmt.Sprintf("TrueDown returned HTTP %d (%s)", e.Status, http.StatusText(e.Status))
}

func New(endpoint, token string) (*Client, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" {
		return nil, fmt.Errorf("endpoint must be an HTTP(S) origin without credentials, path, query or fragment")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("endpoint must use HTTP or HTTPS")
	}
	if port := u.Port(); port != "" {
		p, err := strconv.Atoi(port)
		if err != nil || p < 1 || p > 65535 {
			return nil, fmt.Errorf("endpoint has an invalid port")
		}
	}
	ip := net.ParseIP(u.Hostname())
	local := strings.EqualFold(u.Hostname(), "localhost") || (ip != nil && ip.IsLoopback())
	if !local && (u.Scheme != "https" || token == "") {
		return nil, fmt.Errorf("remote endpoints require HTTPS and TRUEDOWN_API_TOKEN")
	}
	if token != "" {
		if len(token) < 32 || len(token) > 256 || token != strings.TrimSpace(token) {
			return nil, fmt.Errorf("invalid API token")
		}
		for _, c := range []byte(token) {
			if c < 32 || c > 126 {
				return nil, fmt.Errorf("invalid API token")
			}
		}
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	// Local credentials must never be forwarded through an environment proxy.
	transport.Proxy = nil
	return &Client{endpoint: strings.TrimRight(endpoint, "/"), token: token, http: &http.Client{
		Transport:     transport,
		Timeout:       6 * time.Minute,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}, nil
}

func (c *Client) Close() { c.http.CloseIdleConnections() }

func (c *Client) Request(ctx context.Context, method, path string, body any) ([]byte, error) {
	if !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") || strings.ContainsAny(path, "\r\n#") {
		return nil, fmt.Errorf("invalid API path")
	}
	var data []byte
	var err error
	if body != nil {
		data, err = json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("encode request: %w", err)
		}
		if len(data) > 1024*1024 {
			return nil, fmt.Errorf("request exceeds 1 MiB")
		}
	}
	request, err := http.NewRequestWithContext(ctx, method, c.endpoint+path, bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("invalid API request")
	}
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		request.Header.Set("X-Api-Key", c.token)
	}
	response, err := c.http.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		// Do not print a URL or request details that may contain private links.
		return nil, fmt.Errorf("cannot reach TrueDown; check the endpoint and service")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, &HTTPError{Status: response.StatusCode}
	}
	data, err = io.ReadAll(io.LimitReader(response.Body, MaxResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read TrueDown response")
	}
	if len(data) > MaxResponseBytes {
		return nil, fmt.Errorf("TrueDown response exceeds 8 MiB")
	}
	return data, nil
}

// Handshake must succeed before a caller sends task operations to an endpoint.
func (c *Client) Handshake(ctx context.Context) (protocol.Info, error) {
	var info protocol.Info
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	data, err := c.Request(ctx, http.MethodGet, "/system/info", nil)
	if err != nil {
		return info, err
	}
	if json.Unmarshal(data, &info) != nil || info.Product != protocol.Product || info.ProtocolVersion != protocol.Version {
		return info, fmt.Errorf("endpoint is not a compatible TrueDown core (protocol %d required)", protocol.Version)
	}
	return info, nil
}
